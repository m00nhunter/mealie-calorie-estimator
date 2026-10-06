import { config } from "../config.js"
import { logger } from "../utils/logger.js"
import { getCachedNutrients, setCachedNutrients } from "../utils/cache.js"
import { waitForRateLimit, RateLimitType } from "../utils/rate-limiter.js"
import type { OffNutriments, OffProduct, OffSearchResult, NutrientSet } from "../types.js"

export interface OffLookupResult {
  nutrients: NutrientSet | null
  matched: boolean
  productName: string | null
}

const OFF_NUTRIENT_FIELDS = [
  "product_name",
  "serving_size",
  "serving_quantity",
  "serving_quantity_unit",
  "nutriments",
].join(",")

const NON_ITEM_SERVING_UNITS = new Set([
  "g", "gram", "grams", "gramm", "gramme", "kg", "ml", "milliliter", "milliliters",
  "l", "liter", "liters", "cl", "dl", "oz", "ounce", "ounces",
  "portion", "portionen", "serving", "servings", "portion", "cup", "cups",
  "teaspoon", "teaspoons", "tablespoon", "tablespoons",
])

function normalizeServingToken(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
}

function parseServingWeightPerUnit(product: OffProduct, unitName: string): number | null {
  const servingSize = product.serving_size?.trim()
  if (!servingSize) return null

  const match = servingSize.match(/^\s*(\d+(?:[.,]\d+)?)\s*([^\d(]+?)(?:\s*\(|\s*[-–—:]|$)/i)
  if (!match) return null

  const count = Number.parseFloat(match[1].replace(",", "."))
  const servingUnit = normalizeServingToken(match[2])
  if (!Number.isFinite(count) || count <= 0 || !servingUnit) return null
  if (NON_ITEM_SERVING_UNITS.has(servingUnit)) return null

  let servingQuantity: number | null = null
  if (typeof product.serving_quantity === "number") {
    servingQuantity = product.serving_quantity
  } else if (typeof product.serving_quantity === "string") {
    const parsed = Number.parseFloat(product.serving_quantity.replace(",", "."))
    if (Number.isFinite(parsed)) servingQuantity = parsed
  }

  if (servingQuantity === null) {
    const grams = servingSize.match(/(\d+(?:[.,]\d+)?)\s*g\b/i)
    if (!grams) return null
    servingQuantity = Number.parseFloat(grams[1].replace(",", "."))
  }

  if (!Number.isFinite(servingQuantity) || servingQuantity <= 0) return null

  const quantityUnit = normalizeServingToken(product.serving_quantity_unit ?? "")
  if (quantityUnit && quantityUnit !== "g" && quantityUnit !== "gram" && quantityUnit !== "grams" && quantityUnit !== "gramm") {
    return null
  }

  const requestedUnit = normalizeServingToken(unitName)
  const requestedPiece = new Set(["stuck", "stucke", "piece", "pieces", "pc", "pcs"]).has(requestedUnit)
  const requestedSlice = new Set(["scheibe", "scheiben", "slice", "slices"]).has(requestedUnit)
  const requestedClove = new Set(["zehe", "zehen", "clove", "cloves"]).has(requestedUnit)

  if (requestedPiece) {
    return servingQuantity / count
  }

  if (requestedSlice && new Set(["scheibe", "scheiben", "slice", "slices"]).has(servingUnit)) {
    return servingQuantity / count
  }

  if (requestedClove && new Set(["zehe", "zehen", "clove", "cloves"]).has(servingUnit)) {
    return servingQuantity / count
  }

  if (normalizeServingToken(requestedUnit) === servingUnit) {
    return servingQuantity / count
  }

  return null
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

async function fetchWithRetry(url: string, query: string): Promise<Response | null> {
  const { maxRetries, retryBackoffMs, userAgent } = config.openFoodFacts
  let lastResponse: Response | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = retryBackoffMs * 2 ** (attempt - 1)
      logger.debug({ query, attempt, delay }, "Retrying OFF search after backoff")
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    try {
      const res = await fetch(url, { headers: { "User-Agent": userAgent } })
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) {
        return res
      }
      lastResponse = res
      logger.debug({ query, attempt, status: res.status }, "OFF search returned retryable status")
    } catch (err) {
      lastResponse = null
      logger.debug({ query, attempt, err: (err as Error).message }, "OFF search request failed")
    }
  }

  return lastResponse
}

function extractNutrients(n: OffNutriments): NutrientSet {
  const fat = n["fat_100g"] ?? null
  const saturated = n["saturated-fat_100g"] ?? null
  const trans = n["trans-fat_100g"] ?? null

  let unsaturated: number | null = null
  if (fat !== null) {
    const s = saturated ?? 0
    const t = trans ?? 0
    unsaturated = Math.round((fat - s - t) * 10) / 10
  }

  return {
    kcalPer100g: n["energy-kcal_100g"] ?? null,
    proteinPer100g: n["proteins_100g"] ?? null,
    carbsPer100g: n["carbohydrates_100g"] ?? null,
    fatPer100g: fat,
    saturatedFatPer100g: saturated,
    transFatPer100g: trans,
    unsaturatedFatPer100g: unsaturated,
    fiberPer100g: n["fiber_100g"] ?? null,
    sugarPer100g: n["sugars_100g"] ?? null,
    sodiumPer100g: n["sodium_100g"] ?? null,
    cholesterolPer100g: n["cholesterol_100g"] ?? null,
  }
}

async function searchProducts(query: string, pageSize = 1): Promise<OffProduct[]> {
  const params = new URLSearchParams({
    q: query,
    langs: config.openFoodFacts.language,
    page_size: pageSize.toString(),
    fields: OFF_NUTRIENT_FIELDS,
  })

  const url = `${config.openFoodFacts.searchBaseUrl}/search?${params}`

  await waitForRateLimit(RateLimitType.Search)

  const res = await fetchWithRetry(url, query)

  if (!res) {
    logger.warn({ query }, "OFF search failed after retries")
    return null
  }

  if (!res.ok) {
    logger.warn({ status: res.status, query }, "OFF search returned error")
    return null
  }

  let data: OffSearchResult
  try {
    data = (await res.json()) as OffSearchResult
  } catch {
    logger.warn({ query }, "OFF returned non-JSON response")
    return null
  }

  if (!data.hits || data.hits.length === 0) {
    return []
  }

  return data.hits
}

async function searchProduct(query: string): Promise<OffProduct | null> {
  const products = await searchProducts(query, 1)
  return products[0] ?? null
}

export async function lookupServingWeight(foodName: string, unitName: string): Promise<number | null> {
  const products = await searchProducts(foodName, 10)

  for (const product of products) {
    const grams = parseServingWeightPerUnit(product, unitName)
    if (grams !== null) {
      logger.debug(
        { foodName, unitName, product: product.product_name, grams },
        "OFF serving weight found",
      )
      return grams
    }
  }

  logger.debug({ foodName, unitName }, "No explicit OFF serving weight found")
  return null
}

export async function lookupNutrients(foodName: string, unitName?: string): Promise<OffLookupResult> {
  const cached = getCachedNutrients(foodName)
  if (cached) {
    logger.debug({ foodName }, "Cache hit for food")
    return { nutrients: cached, matched: true, productName: foodName }
  }

  let searchTerm = foodName
  if (unitName && searchTerm.toLowerCase().startsWith(unitName.toLowerCase())) {
    searchTerm = searchTerm.slice(unitName.length).trim()
  }

  const product = await searchProduct(searchTerm)

  if (!product) {
    logger.debug({ foodName }, "No OFF match found")
    return { nutrients: null, matched: false, productName: null }
  }

  if (!product.nutriments) {
    logger.debug({ foodName, product: product.product_name }, "OFF match has no nutrient data")
    return { nutrients: null, matched: false, productName: product.product_name }
  }

  const nutrients = extractNutrients(product.nutriments)

  if (nutrients.kcalPer100g === null) {
    logger.debug({ foodName, product: product.product_name }, "OFF match has no kcal data")
    return { nutrients: null, matched: false, productName: product.product_name }
  }

  logger.debug({ foodName, product: product.product_name }, "OFF match found")
  setCachedNutrients(foodName, nutrients)
  return { nutrients, matched: true, productName: product.product_name }
}
