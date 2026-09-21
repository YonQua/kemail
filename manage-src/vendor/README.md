# Vendored frontend libraries

- `alpine.cdn.min.js`: `@alpinejs/csp` 3.14.9, https://cdn.jsdelivr.net/npm/@alpinejs/csp@3.14.9/dist/cdn.min.js
- This version resolves property paths and method references, not inline JavaScript expressions. Keep logic in `manage.js` getters/methods.
- `npm run build:manage` rejects unsupported template bindings before writing assets. The checker is a limited syntax guard for repository templates, not a full HTML parser or a property-existence/runtime check. It intentionally permits only the directive subset used by this project; review new directives before extending it.
- When updating Alpine, review the exact pinned version and iframe bindings; current upstream documentation may describe a different evaluator.
