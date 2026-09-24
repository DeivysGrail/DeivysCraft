# DeivysCraft

DeivysCraft est un jeu de fusion inspiré d'Infinite Craft, centré sur la pop culture, les créateurs, le cinéma, les jeux vidéo, la musique et bien plus.

## Structure du projet

```text
DeivysCraft/
├─ index.html
├─ style.css
├─ game.js
├─ recipe-editor.html
├─ vercel.json
└─ src/
   └─ data/
      ├─ craft-db.json
      └─ craft-full.bin
```

Le jeu public charge `src/data/craft-db.json`.  
`craft-full.bin` reste synchronisé avec la base pour l'éditeur et les exports.

## Recipe Editor

Ouvre `recipe-editor.html` via un serveur local, par exemple WebStorm.

L'éditeur peut charger `src/data/craft-db.json`, modifier les éléments et recettes, puis exporter :
- `craft-db.json`
- `craft-full.bin`

Pour publier une nouvelle version de la base, remplace ensuite les deux fichiers dans `src/data/` et pousse les changements sur `main`. Vercel redéploiera automatiquement le site une fois le dépôt connecté.

## Modes

- Mode libre
- Contre la montre
- Speedrun
- Catégories et difficultés
- Indices progressifs
- Records locaux
- Récapitulatif du chemin gagnant

## Vercel

Le projet est statique et ne nécessite pas de build.

- Framework Preset : Other
- Root Directory : `./`
- Build Command : vide
- Output Directory : vide

## Créateur

Twitch : [DeivysLive](https://www.twitch.tv/DeivysLive)
