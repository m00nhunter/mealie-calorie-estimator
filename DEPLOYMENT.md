# Production deployment

## Architecture

The production deployment uses GitHub as the source of truth for the Portainer stack:

```text
m00nhunter/mealie-calorie-estimator
        |
        | GitHub Actions
        v
GHCR
        |
        | Docker image
        v
Portainer GitOps
        |
        v
HOMEDOMENAS06
        |
        +-- mealie
        +-- mealie-calorie-estimator
        +-- mealie-postgres
```

## Docker image

Current production image:

```text
ghcr.io/m00nhunter/mealie-calorie-estimator:referenced-recipe-nutrition
```

It is built by `.github/workflows/docker-ghcr.yml` whenever `feature/referenced-recipe-nutrition` is pushed, and the workflow can also be started manually.

## Portainer

The production stack is stored in:

```text
m00nhunter/Portainer-stacks
10.0.10.20/mealie/compose.yml
```

The estimator service points to the feature image above.

Deployment procedure:

1. Push and validate estimator changes.
2. Confirm GitHub Actions succeeds.
3. Update the Portainer stack from Git.
4. Pull and redeploy.
5. Verify the running image.
6. Trigger an estimation for a recipe containing referenced recipes.
7. Verify logs and the resulting Mealie nutrition.

## Verification

```bash
docker inspect mealie-calorie-estimator --format '{{.Config.Image}}'
docker ps --filter name=mealie-calorie-estimator
docker logs --tail 50 mealie-calorie-estimator
```

Expected image:

```text
ghcr.io/m00nhunter/mealie-calorie-estimator:referenced-recipe-nutrition
```

## Production validation

The referenced-recipe implementation was validated with `tonkotsu-ramen-mit-chashu`.

The production logs demonstrated recursive processing of:

- chashu-gerollter-schweinebauch
- ramen-eier
- miso-tare
- tonkotsu-japanische-schweinebruhe-fur-ramen-nudelsuppen
- tonkotsu-ramen-mit-chashu

The parent recipe was successfully updated in Mealie.

## Image tagging policy

The current feature tag is intentionally easy to consume:

```text
referenced-recipe-nutrition
```

For long-term reproducibility, future releases should also publish an immutable versioned tag, for example `1.13.0-referenced-recipe-nutrition`. Production can then be pinned to a specific release while the moving feature tag remains useful for development.
