# Waybill Scan H5

A single-page mobile-first H5 app that helps logistics operators extract
structured fields (carrier, product name, two tracking numbers, 省内/省外)
from express waybill images using an AI vision model.

## Run locally

Just open `index.html` in any modern mobile browser. No build step.

## Deploy

This repo is wired to Cloudflare Pages via Git integration. Every push to
`main` triggers an automatic deploy to `https://waybill-scan-h5.pages.dev`.

## Files

- `index.html` — the entire app (HTML + CSS + JS, ~16 KB, no framework).