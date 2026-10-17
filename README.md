# Dungeon Rule Editor

Continuing development in a new Codex chat or on another computer? Read [HANDOFF.md](HANDOFF.md) for the project decisions, code entry points, and Windows setup notes.

A local-first browser editor for modular 3D map rules. Import FBX files to calculate X/Y/Z occupancy boxes, define rectangular side connectors, edit directed type relationships, and preview generated maps. The editor processes files in the browser; it does not upload models or generate a Unity scene.

## Run locally

Use Node.js 24 or newer:

```bash
npm ci
npm run dev
```

`npm test` runs the rule tests, and `npm run build` creates the static site in `dist/`. The project can run on macOS and Windows browsers and deploy to GitHub Pages using the included workflow.

## Workflow

1. Set the number of modules after the unique start, the start type, and the project-wide connector width and height. Both connector dimensions default to 1 m.
2. Right-click the type graph background to create or arrange types. Right-click a type to edit, connect, or delete it. Relations are directed; the number on each arrow is its relative generation weight.
3. Add an FBX to a type's module slots. Its filename becomes the module ID. The editor computes the model's three-dimensional bounds relative to its origin. Use the collapsed Advanced bounds section only when the occupancy box needs correction.
4. Open the module window to place and drag rectangular ports on the sides of the 3D box, or enter precise local X/Y/Z coordinates. A connector must fit completely within one vertical side face. Set per-port target-type permissions if needed.
5. Generate a map from a visible seed. Both the module editor and the preview support mouse orbit, middle or right drag pan, wheel zoom, Fit, and **F** to focus. The 3D preview uses colored boxes rather than rendering FBX. Connected connectors have an empty solid outline; unused connectors have a solid hatched outline and do not cause warnings.

Projects autosave locally in IndexedDB. The file menu can save and reopen ZIP projects with original FBX files, or import and export runtime JSON without models and editor layout. Runtime JSON and ZIP use v4; v3 and older files are not migrated. Their schemas and generation behavior are documented in [`schema/runtime-v4.schema.json`](schema/runtime-v4.schema.json) and [`ALGORITHM.md`](ALGORITHM.md).

## Unity agreement

The editor converts FBX `UnitScaleFactor` to metres and stores geometry in integer millimetres. Keep the imported prefab's root and scene scale at 1, and align Unity's X/Y/Z and 90° Y-axis rotations with the exported data. The occupancy box is a placement approximation; Unity performs actual scene collision and instantiation. Bridge, stair, room, and corridor geometry are ordinary modules. Unity can create doors at connected ports and seal unused ones.

## Publishing

Push this directory as a public repository root. In GitHub Settings → Pages choose **GitHub Actions**. The included workflow tests, builds, and publishes the static site. Keep project ZIPs, FBX assets, and personal rules out of the source repository.
