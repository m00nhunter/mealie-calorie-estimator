import crypto from "node:crypto"
import type {
  MealieRecipe, MealieIngredient, IngredientMatch, EstimateResult, NutritionPatch,
  NutrientSet, MealieNutrition,
} from "../types.js"
import { config } from "../config.js"
import { convertToGrams } from "./unit-converter.js"
import { lookupNutrients } from "./off-client.js"
import { estimateGrams, estimateNutrients } from "./llm-estimator.js"
import { logger } from "../utils/logger.js"

export function computeIngredientHash(recipe: MealieRecipe): string {
  const parts: string[] = []

  for (const ing of recipe.recipeIngredient) {
    const qty = ing.quantity ?? 0
    const unitName = ing.unit?.name ?? ""
    const foodName = ing.food?.name ?? ""
    const referencedSlug = ing.referencedRecipe?.slug ?? ""
    parts.push(`${qty}|${unitName}|${foodName}|${referencedSlug}`)
  }

  parts.sort()
  parts.push(`servings:${recipe.recipeServings ?? ""}`)
  parts.push(`yieldQuantity:${recipe.recipeYieldQuantity ?? ""}`)
  const hash = crypto.createHash("sha256").update(parts.join(",")).digest("hex")
  return hash
}

export function shouldEstimate(recipe: MealieRecipe): boolean {
  if (config.estimate.strategy === "all") return true
  const tagName = config.estimate.tag.toLowerCase()
  return (recipe.tags || []).some(t => t.slug === tagName || t.name.toLowerCase() === tagName)
}


function emptyNutrients(): NutrientSet {
  return {
    kcalPer100g: null,
    proteinPer100g: null,
    carbsPer100g: null,
    fatPer100g: null,
    saturatedFatPer100g: null,
    transFatPer100g: null,
    unsaturatedFatPer100g: null,
    fiberPer100g: null,
    sugarPer100g: null,
    sodiumPer100g: null,
    cholesterolPer100g: null,
  }
}

function addToTotal(total: NutrientSet, nutrients: NutrientSet, grams: number): NutrientSet {
  const factor = grams / 100
  const add = (a: number | null, b: number | null): number | null => {
    if (a === null && b === null) return null
    return (a ?? 0) + (b ?? 0) * factor
  }

  return {
    kcalPer100g: add(total.kcalPer100g, nutrients.kcalPer100g),
    proteinPer100g: add(total.proteinPer100g, nutrients.proteinPer100g),
    carbsPer100g: add(total.carbsPer100g, nutrients.carbsPer100g),
    fatPer100g: add(total.fatPer100g, nutrients.fatPer100g),
    saturatedFatPer100g: add(total.saturatedFatPer100g, nutrients.saturatedFatPer100g),
    transFatPer100g: add(total.transFatPer100g, nutrients.transFatPer100g),
    unsaturatedFatPer100g: add(total.unsaturatedFatPer100g, nutrients.unsaturatedFatPer100g),
    fiberPer100g: add(total.fiberPer100g, nutrients.fiberPer100g),
    sugarPer100g: add(total.sugarPer100g, nutrients.sugarPer100g),
    sodiumPer100g: add(total.sodiumPer100g, nutrients.sodiumPer100g),
    cholesterolPer100g: add(total.cholesterolPer100g, nutrients.cholesterolPer100g),
  }
}

function scaleNutrients(nutrients: NutrientSet, factor: number): NutrientSet {
  const scale = (v: number | null): number | null => v !== null ? v * factor : null
  return {
    kcalPer100g: scale(nutrients.kcalPer100g), proteinPer100g: scale(nutrients.proteinPer100g), carbsPer100g: scale(nutrients.carbsPer100g), fatPer100g: scale(nutrients.fatPer100g), saturatedFatPer100g: scale(nutrients.saturatedFatPer100g), transFatPer100g: scale(nutrients.transFatPer100g), unsaturatedFatPer100g: scale(nutrients.unsaturatedFatPer100g), fiberPer100g: scale(nutrients.fiberPer100g), sugarPer100g: scale(nutrients.sugarPer100g), sodiumPer100g: scale(nutrients.sodiumPer100g), cholesterolPer100g: scale(nutrients.cholesterolPer100g),
  }
}

function addNutrients(total: NutrientSet, add: NutrientSet): NutrientSet {
  const sum = (a: number | null, b: number | null): number | null => a === null && b === null ? null : (a ?? 0) + (b ?? 0)
  return {
    kcalPer100g: sum(total.kcalPer100g, add.kcalPer100g), proteinPer100g: sum(total.proteinPer100g, add.proteinPer100g), carbsPer100g: sum(total.carbsPer100g, add.carbsPer100g), fatPer100g: sum(total.fatPer100g, add.fatPer100g), saturatedFatPer100g: sum(total.saturatedFatPer100g, add.saturatedFatPer100g), transFatPer100g: sum(total.transFatPer100g, add.transFatPer100g), unsaturatedFatPer100g: sum(total.unsaturatedFatPer100g, add.unsaturatedFatPer100g), fiberPer100g: sum(total.fiberPer100g, add.fiberPer100g), sugarPer100g: sum(total.sugarPer100g, add.sugarPer100g), sodiumPer100g: sum(total.sodiumPer100g, add.sodiumPer100g), cholesterolPer100g: sum(total.cholesterolPer100g, add.cholesterolPer100g),
  }
}

function divideByServings(total: NutrientSet, servings: number): NutrientSet {
  const div = (v: number | null): number | null => (v !== null ? Math.round(v / servings) : null)
  return {
    kcalPer100g: div(total.kcalPer100g),
    proteinPer100g: div(total.proteinPer100g),
    carbsPer100g: div(total.carbsPer100g),
    fatPer100g: div(total.fatPer100g),
    saturatedFatPer100g: div(total.saturatedFatPer100g),
    transFatPer100g: div(total.transFatPer100g),
    unsaturatedFatPer100g: div(total.unsaturatedFatPer100g),
    fiberPer100g: div(total.fiberPer100g),
    sugarPer100g: div(total.sugarPer100g),
    sodiumPer100g: div(total.sodiumPer100g),
    cholesterolPer100g: div(total.cholesterolPer100g),
  }
}

function formatQuantity(quantity: number, unit: MealieIngredient["unit"]): string {
  const quantityText = Number.isInteger(quantity) ? quantity.toString() : quantity.toString()
  const unitName = unit?.name?.trim()
  return unitName ? quantityText + " " + unitName : quantityText
}

interface IngredientOutcome {
  foodName: string
  grams: number | null
  quantityLabel: string
  nutrients: NutrientSet | null
  kcalContribution: number | null
  llmEstimated: boolean
}

async function evaluateIngredient(ing: MealieIngredient): Promise<IngredientOutcome | null> {
  const foodName = ing.food?.name
  const quantity = ing.quantity

  if (!foodName || quantity == null || quantity <= 0) {
    return null
  }

  let grams = convertToGrams(quantity, ing.unit)
  let llmEstimated = false

  if (grams === null) {
    const unitName = ing.unit?.name
    if (unitName) {
      const llmGrams = await estimateGrams(quantity, unitName, foodName)
      if (llmGrams !== null) {
        grams = llmGrams
        llmEstimated = true
      }
    }
  }

  if (grams === null) {
    return { foodName, grams: null, quantityLabel: formatQuantity(quantity, ing.unit), nutrients: null, kcalContribution: null, llmEstimated: false }
  }

  const result = await lookupNutrients(foodName, ing.unit?.name)

  if (!result.matched || result.nutrients === null) {
    const llmNutrients = await estimateNutrients(foodName)
    if (llmNutrients !== null) {
      return { foodName, grams, quantityLabel: formatQuantity(quantity, ing.unit), nutrients: llmNutrients, kcalContribution: llmNutrients.kcalPer100g !== null ? llmNutrients.kcalPer100g * grams / 100 : null, llmEstimated: true }
    }
    return { foodName, grams, quantityLabel: formatQuantity(quantity, ing.unit), nutrients: null, kcalContribution: null, llmEstimated: false }
  }

  return { foodName, grams, quantityLabel: formatQuantity(quantity, ing.unit), nutrients: result.nutrients, kcalContribution: result.nutrients.kcalPer100g !== null ? result.nutrients.kcalPer100g * grams / 100 : null, llmEstimated }
}

interface EstimateContext { stack: Set<string> }

async function evaluateReferencedRecipe(ing: MealieIngredient, context: EstimateContext): Promise<{ nutrients: NutrientSet; name: string; quantityLabel: string } | null> {
  const referenced = ing.referencedRecipe
  const quantity = ing.quantity
  if (!referenced?.slug || quantity == null || quantity <= 0 || context.stack.has(referenced.slug)) return null
  const result = await estimateRecipe(referenced, { stack: new Set([...context.stack, referenced.slug]) })
  if (result.servings == null || result.servings <= 0 || result.totalNutrients.kcalPer100g === null) return null
  return { name: referenced.name || referenced.slug, quantityLabel: formatQuantity(quantity, ing.unit), nutrients: scaleNutrients(result.perServingNutrients, quantity) }
}

export async function estimateRecipe(recipe: MealieRecipe, context: EstimateContext = { stack: new Set([recipe.slug]) }): Promise<EstimateResult> {
  const matchedIngredients: IngredientMatch[] = []
  const unmatchedNames: string[] = []
  let totalNutrients = emptyNutrients()

  const outcomes = await Promise.all(recipe.recipeIngredient.map(async (ing) => {
    if (ing.referencedRecipe) return { kind: "recipe" as const, ingredient: ing, result: await evaluateReferencedRecipe(ing, context) }
    return { kind: "food" as const, result: await evaluateIngredient(ing) }
  }))

  for (const outcome of outcomes) {
    if (outcome.kind === "recipe") {
      const name = outcome.result?.name ?? outcome.ingredient.referencedRecipe?.name ?? outcome.ingredient.referencedRecipe?.slug ?? "Referenced recipe"
      if (outcome.result === null) {
        unmatchedNames.push(name)
        matchedIngredients.push({ name, grams: null, quantityLabel: outcome.ingredient.quantity != null ? formatQuantity(outcome.ingredient.quantity, outcome.ingredient.unit) : "", kcalContribution: null, matched: false, nutrients: null })
      } else {
        totalNutrients = addNutrients(totalNutrients, outcome.result.nutrients)
        matchedIngredients.push({ name, grams: null, quantityLabel: outcome.result.quantityLabel, kcalContribution: outcome.result.nutrients.kcalPer100g, matched: true, nutrients: outcome.result.nutrients })
      }
      continue
    }

    const ingredientOutcome = outcome.result
    if (ingredientOutcome === null) continue
    if (ingredientOutcome.grams === null || ingredientOutcome.nutrients === null) {
      unmatchedNames.push(ingredientOutcome.foodName)
      matchedIngredients.push({ name: ingredientOutcome.foodName, grams: ingredientOutcome.grams, quantityLabel: ingredientOutcome.quantityLabel, kcalContribution: null, matched: false, nutrients: null })
      continue
    }
    totalNutrients = addToTotal(totalNutrients, ingredientOutcome.nutrients, ingredientOutcome.grams)
    matchedIngredients.push({ name: ingredientOutcome.foodName, grams: ingredientOutcome.grams, quantityLabel: ingredientOutcome.quantityLabel, kcalContribution: ingredientOutcome.kcalContribution, matched: true, nutrients: ingredientOutcome.nutrients, llmEstimated: ingredientOutcome.llmEstimated })
  }

  const servings = recipe.recipeServings ?? recipe.recipeYieldQuantity ?? 1
  const perServingNutrients = servings && servings > 0 ? divideByServings(totalNutrients, servings) : emptyNutrients()

  const result: EstimateResult = {
    slug: recipe.slug,
    servings,
    totalNutrients,
    perServingNutrients,
    matchedCount: matchedIngredients.filter((i) => i.matched).length,
    unmatchedCount: unmatchedNames.length,
    unmatchedIngredients: unmatchedNames,
    matchedIngredients,
  }

  logger.info(
    {
      slug: recipe.slug,
      servings,
      totalKcal: totalNutrients.kcalPer100g,
      kcalPerServing: perServingNutrients.kcalPer100g,
      matched: result.matchedCount,
      unmatched: result.unmatchedCount,
    },
    "Estimated nutrition for recipe",
  )

  return result
}

export function hasManualCalories(recipe: MealieRecipe): boolean {
  const hasHash = recipe.extras?.calorie_estimator_hash != null
  const hasStoredNutrition =
    recipe.nutrition?.calories != null && recipe.nutrition.calories.trim().length > 0

  return !hasHash && hasStoredNutrition
}

export function buildManualAckPatch(recipe: MealieRecipe, hash: string): NutritionPatch {
  return {
    extras: {
      ...recipe.extras,
      calorie_estimator_hash: hash,
      calorie_estimator_unmatched: JSON.stringify([]),
      calorie_estimator_note: "Manual — preserved existing calorie entry",
    },
  }
}

function n(v: number | null): string {
  return v != null ? v.toString() : ""
}

export const NUTRITION_DETAILS_NOTE_TITLE = "Nutrition calculation details"

function formatKcal(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  return Math.round(value).toLocaleString("de-CH").replace(/’/g, "'")
}

export function buildNutritionCalculationNote(result: EstimateResult): RecipeNote {
  const rows = result.matchedIngredients.map((ingredient) => ({
    name: ingredient.name,
    quantity: ingredient.quantityLabel ?? "",
    kcal: formatKcal(ingredient.kcalContribution ?? null),
  }))
  const nameWidth = Math.max("Zutat".length, ...rows.map((r) => r.name.length))
  const quantityWidth = Math.max("Menge".length, ...rows.map((r) => r.quantity.length))
  const kcalWidth = Math.max("kcal".length, ...rows.map((r) => r.kcal.length), formatKcal(result.totalNutrients.kcalPer100g).length)
  const separator = "-".repeat(nameWidth + quantityWidth + kcalWidth + 6)
  const line = (name: string, quantity: string, kcal: string) => name.padEnd(nameWidth) + "  " + quantity.padEnd(quantityWidth) + "  " + kcal.padStart(kcalWidth)
  const lines = ["```", line("Zutat", "Menge", "kcal"), separator, ...rows.map((row) => line(row.name, row.quantity, row.kcal)), separator, line("Gesamt", "", formatKcal(result.totalNutrients.kcalPer100g))]
  if (result.servings != null && result.servings > 0) lines.push(line("Pro Portion", "(" + result.servings + ")", formatKcal(result.perServingNutrients.kcalPer100g)))
  if (result.unmatchedIngredients.length > 0) lines.push("", "Nicht berechnet: " + result.unmatchedIngredients.join(", "))
  lines.push("```")
  return { title: NUTRITION_DETAILS_NOTE_TITLE, text: lines.join("\n") }
}

export function mergeNutritionCalculationNote(recipe: MealieRecipe, result: EstimateResult): RecipeNote[] {
  const note = buildNutritionCalculationNote(result)
  const existing = recipe.notes ?? []
  return [...existing.filter((item) => item.title !== NUTRITION_DETAILS_NOTE_TITLE), note]
}

export function buildNutritionPatch(
  result: EstimateResult,
  hash: string,
): NutritionPatch {
  const llmIngredients = result.matchedIngredients
    .filter((i) => i.llmEstimated)
    .map((i) => i.name)

  const extras: Record<string, string> = {
    calorie_estimator_hash: hash,
    calorie_estimator_unmatched: JSON.stringify(result.unmatchedIngredients),
  }

  if (llmIngredients.length > 0) {
    extras.calorie_estimator_llm_ingredients = JSON.stringify(llmIngredients)
  }

  const p = result.perServingNutrients
  const totalKcal = result.totalNutrients.kcalPer100g
  if (totalKcal !== null && totalKcal > 0) {
    extras.calorie_estimator_total_kcal = totalKcal.toString()
  }

  if (result.servings !== null) {
    extras.calorie_estimator_yield = result.servings.toString()
  }

  const nutrition: Partial<MealieNutrition> = {}
  const add = (key: keyof MealieNutrition, val: string) => {
    if (val !== "") nutrition[key] = val
  }

  add("calories", n(p.kcalPer100g))
  add("proteinContent", n(p.proteinPer100g))
  add("carbohydrateContent", n(p.carbsPer100g))
  add("fatContent", n(p.fatPer100g))
  add("saturatedFatContent", n(p.saturatedFatPer100g))
  add("transFatContent", n(p.transFatPer100g))
  add("unsaturatedFatContent", n(p.unsaturatedFatPer100g))
  add("fiberContent", n(p.fiberPer100g))
  add("sugarContent", n(p.sugarPer100g))
  add("sodiumContent", n(p.sodiumPer100g))
  add("cholesterolContent", n(p.cholesterolPer100g))

  return { nutrition, extras }
}
