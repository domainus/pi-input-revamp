# @nerisma/pi-input-revamp

Remplace l'éditeur d'input de [pi](https://pi.dev) par un **cadre arrondi
complet**, un caractère de prompt **π** coloré, et une **barre de métriques de
session** intégrée à la bordure.

```
┌─ agent · anthropic/claude-sonnet-4-5 · high ──── 0.015$ · 15.2K (2.1K|8.3K) · 12.3% ─╮
│ π hello world                                                                          │
╰────────────────────────────────────────────────────────────────────────────────────────╯
```

La bordure et le π utilisent la couleur `accent` du thème actif. La barre du
haut affiche le modèle, le coût, les tokens (avec détail input/cache), et le
pourcentage de contexte consommé.

## Installation

```bash
pi install npm:@nerisma/pi-input-revamp
```

Ou via `settings.json` :

```json
{
  "packages": ["npm:@nerisma/pi-input-revamp"]
}
```

## Fonctionnement

Contrairement à la plupart des extensions d'éditeur qui post-traitent le
résultat de `super.render()`, celle-ci construit le rendu **from scratch** via
`this.layoutText()` pour le word-wrapping. Cela donne un contrôle total sur
l'espacement et évite les interférences du `paddingX` interne.

## Note sur le décompte d'outils

La barre affiche le nombre d'outils actifs via `pi.getActiveTools()`. Dans le
setup multi-agents d'origine de l'auteur, ce décompte était affiné par
l'allow-list du frontmatter de l'agent actif ; la version publiée reste
générique et n'a aucune dépendance externe.

## Compatibilité

- pi `>= 0.78`
- Compatible avec `@nerisma/pi-tool-border` (qui agit sur les outils, pas sur
  l'éditeur).

## Licence

MIT © Sébastien SERVOUZE
