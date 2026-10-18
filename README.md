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

1. Set the number of modules after the unique start and the start type. **Door types** list the door opening sizes in the project; they are usually created for you from door meshes when you import FBX files, and you can rename them, change their size, or add one by hand. Each size is one door type, and ports only connect to ports of the same door type.
2. Right-click the type graph background to create types or **Arrange** them (Arrange tidies your current layout into rows and aligned columns, keeping the order you placed them in). Right-click a type to edit, connect, or delete it. Relations are directed; the number on each arrow is its relative generation weight. Type, module and new-type details all open in one docked panel on the right; opening another replaces it, and **Esc** or × closes it.
3. Add models. Either choose or drop an FBX on a type's **+ Add module** slot, or use **Models** to upload a whole folder (or several FBX files): press **Auto-assign all**, or pick a type and press **Assign**, or drag a row onto a type's slot. Models are recognised from their names, which are never changed:
   - the file name is the module ID (`CorridorConnection_Ten_Small.fbx` → `CorridorConnection_Ten_Small`);
   - the text before the first `_` is the type (`CorridorConnection`), created if it doesn't exist;
   - the mesh named like the file is the module's body and defines its occupancy box;
   - every mesh with `Door` in its name is a port: its full mesh name is the port ID, its centre must lie on a side face of the box (that face is the port's side, i.e. the door's outward Z in Unity), and its width and height pick or create the door type.

   A name that isn't a valid ID (start with a letter; letters, numbers, `_` or `-` only), two door meshes with the same name, or a door that isn't on a side face is reported, and the file can't be used until it is fixed in Maya or on disk. Replacing a module's model rebuilds its ports from the new file. For open-top modules such as a rooftop or a field, tick **Open to sky** (suggested automatically when a door mesh rises above the model's top) or set **Space above** in the module panel: Normal, Open to sky (nothing is ever placed above it), or a custom height (modules may sit above that height). Each type also has soft **placement preferences**: *distance from start* (near ↔ far, in steps) and *floor height* (low ↔ high), each a percentage from −100 % to 100 % with presets. They make a type tend towards those places without ever blocking a placement. Use the collapsed Advanced bounds section only when the occupancy box needs correction.
4. In the module panel, place and drag rectangular ports on the sides of the 3D box, or click a port to edit its ID, local X/Y/Z position and target types. Fields save on Enter or when you leave them. A port's centre must lie on a vertical side face of the box; the door opening itself may overhang the face's edges, top or bottom.
5. Generate a map from a visible seed. Every 3D view supports left-drag orbit, right or middle drag pan and wheel zoom, and stops as soon as you release the mouse. Hovering highlights a module or port, double-click focuses it, **F** focuses the hovered item and **Fit** shows everything. **Camera** sets rotate, pan and zoom speed for all 3D views; the speeds are remembered in this browser. The 3D preview uses colored boxes rather than rendering FBX. Connected connectors have an empty solid outline; unused connectors have a solid hatched outline and do not cause warnings.

Projects autosave locally in IndexedDB, including unassigned models in Models. The file menu can save and reopen ZIP projects with original FBX files (assigned and unassigned), or import and export runtime JSON without models and editor layout. Runtime JSON and ZIP use v5; v4 and older files are not migrated. Their schemas and generation behavior are documented in [`schema/runtime-v5.schema.json`](schema/runtime-v5.schema.json) and [`ALGORITHM.md`](ALGORITHM.md).

## Unity agreement

The editor converts FBX `UnitScaleFactor` to metres and stores geometry in integer millimetres. Keep the imported prefab's root and scene scale at 1, and align Unity's X/Y/Z and 90° Y-axis rotations with the exported data. The occupancy box is a placement approximation; Unity performs actual scene collision and instantiation. Bridge, stair, room, and corridor geometry are ordinary modules. Unity can create doors at connected ports and seal unused ones.

## Publishing

Push this directory as a public repository root. In GitHub Settings → Pages choose **GitHub Actions**. The included workflow tests, builds, and publishes the static site. Keep project ZIPs, FBX assets, and personal rules out of the source repository.
