# Ambulando web

The approved Ambulando marketing v7, packaged as a static Nginx website for CapRover. No runtime secrets, database, package installation or build tooling is needed.

## CapRover setup

- Repository: `https://github.com/OtherStuffAI/ambulando-web.git`
- Build branch: `deployed`
- Captain definition: `/captain-definition` at repository root (schema 2).
- Container HTTP port: **80**.
- Enable HTTPS on your chosen domain. No persistent directories or environment variables are required.
- Check `/health`, `/`, stylesheet and image loading after deployment.

## Local container

```sh
docker build -t ambulando-web .
docker run --rm -p 8080:80 ambulando-web
```

Open `http://localhost:8080/`. `/health` identifies artifact version v7. Missing paths return 404.

## Review and release

The page, styles, scripts and product assets in `public/` are byte-for-byte identical to the approved private artifact. Private review attachment files are excluded:
https://pale-log-tank.rick.runwingman.com/artifacts/Wingman_Suite/ambulando-marketing/v7/

Preserve that surface for comments and direction. Create new artifact versions for later review rounds, then copy the approved files into `public/` so the website and review version stay aligned. Artifact review controls are added by the Artifact WApp, not shipped with this website.

Develop on `main`, validate and push it, then fast-forward `deployed` from `main` and push `deployed`. Return to `main`. Avoid merge commits, resets, rebases and force pushes in the deployment path.

The hero retains a labelled product-video placeholder until a video URL is supplied. Product screenshots use isolated sample data; the business/time example is illustrative. See `public/source-notes.md` for provenance and claim boundaries.
