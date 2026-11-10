# Songes 🌙

Jeu d'ambiance de mots pour 4 à 10 joueurs, sur **un seul téléphone** qu'on se passe autour de la table.

👉 **Jouer : https://chamayonaise.github.io/When-I-Dream/**

## Principe

À chaque manche, un joueur est le **Rêveur** : les yeux fermés, il doit deviner un maximum de mots grâce aux indices (un mot chacun, à tour de rôle) des autres joueurs, qui ont reçu un rôle secret :

| Rôle | Gagne… |
|---|---|
| 🧚 Fée | 1 point par mot deviné |
| 👹 Croque-Mitaine | 1 point par mot raté ou passé |
| ⏳ Marchand de sable | si les deux piles restent équilibrées (égalité : devinés + 2 ; écart de 1 : le plus grand ; écart ≥ 2 : le plus petit) |
| 🌙 Rêveur | 1 point par mot deviné, +2 s'il les cite tous dans son récit |

L'application gère : distribution secrète des rôles, minuteur de la Nuit (son + vibration à la fin), boutons ✓ / ✗ discrets, annulation, pénalités, récit du Jour avec cases à cocher, calcul des scores et classement final (égalité départagée par les pénalités).

Les règles complètes sont accessibles dans l'application.

## Technique

- Site 100 % statique (HTML / CSS / JS, aucune dépendance ni build) — hébergé sur GitHub Pages.
- Mots aléatoires en français via l'API gratuite [trouve-mot.fr](https://trouve-mot.fr) (`/api/random/50`), avec une liste de secours hors ligne (`words-fallback.js`).
- Partie sauvegardée dans le navigateur (`localStorage`) : on peut recharger la page sans perdre les scores.
- Écran maintenu allumé pendant la partie (Wake Lock API) ; installable sur l'écran d'accueil.

## Lancer en local

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```
