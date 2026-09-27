# DeivysCraft — version complète avec Recipe Editor

Cette archive correspond à la version publique actuelle du jeu, avec le Recipe Editor privé réintégré pour le travail local.

## Structure

- `index.html` : interface publique du jeu
- `style.css` : styles et responsive
- `game.js` : moteur du jeu
- `src/data/craft-db.json` : base éditable
- `src/data/craft-full.bin` : base binaire synchronisée
- `recipe-editor.html` : Recipe Editor V15 Full, à garder privé
- `vercel.json` : configuration Vercel

## Workflow recommandé

1. Travailler localement dans WebStorm.
2. Ouvrir `recipe-editor.html` via le serveur local WebStorm.
3. Charger/modifier `src/data/craft-db.json`.
4. Exporter `craft-db.json` et `craft-full.bin` depuis l'éditeur.
5. Remplacer les deux fichiers dans `src/data/`.
6. Tester le jeu localement.
7. Pousser uniquement les fichiers publics sur GitHub. Ne pas republier `recipe-editor.html`.

Le jeu inclut la fenêtre `Tous les éléments`, la recherche, le responsive mobile compact des catégories et les boutons de tri par icônes.


## Base de départ

Le joueur commence avec `Personne`, `Objet`, `Idée` et `Internet`. La recette `Personne + Personne → Célébrités` ouvre désormais la branche des célébrités.


## Canvas de fusion

Deux méthodes sont disponibles : sélection classique de 2 éléments ou Canvas.

Dans le Canvas :
- clic simple sur un élément de la collection : l'ajouter au Canvas ;
- glisser depuis la collection : le placer exactement où tu veux ;
- glisser directement sur un élément déjà posé : fusion immédiate ;
- superposer deux éléments posés : fusion ;
- clic simple sur un élément posé : suppression ;
- double clic : duplication ;
- triple clic : fusion de l'élément avec lui-même ;
- `Vider le canvas` supprime tout ce qui est posé.