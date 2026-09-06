# 🐀 Rat des Tombolas

**https://ratdestombolas.com**

Sois prévenu dès qu'une tombola démarre sur les chaînes du ZEVENT.

**Gratuit, sans compte, rien ne quitte ton navigateur.** La page écoute les chats Twitch des plus grosses chaînes du plateau, détecte les annonces de tombola faites par les modérateurs, et t'envoie une notification avec le lien pour participer.

## Comment ça marche

- Ton navigateur se connecte au chat Twitch des chaînes surveillées, en anonyme, comme un spectateur qui lit le chat.
- Une tombola est détectée quand un **modérateur, le streamer ou le bot de la chaîne** l'annonce (« 1€ = 1 ticket », lien de don, « tombola en cours »…). Les messages des viewers ne comptent pas, ils réclament plus qu'ils n'annoncent.
- Elle est considérée terminée quand plus personne d'officiel n'en parle depuis 8 minutes. C'est une estimation : vérifie sur le stream.
- Pas de serveur, pas de compte, pas de suivi. L'historique reste sur ton appareil.

## Utiliser

Ouvre la page, clique « Activer les notifications », épingle l'onglet. C'est tout.

## Lancer en local

Le site est statique (`docs/`). N'importe quel serveur de fichiers fait l'affaire :

```
cd docs && python3 -m http.server 8790
```

Puis http://localhost:8790.

## Version « watcher » (Node)

`tombola-watch.mjs` écoute les mêmes chats depuis Node 22 (zéro dépendance), sert la page publique sur http://localhost:8787 et écrit des logs détaillés dans `watch-logs/` (scores toutes les 10 s, alertes, messages des modérateurs, chat pendant les tombolas). C'est l'outil qui a servi à construire et régler la détection hors ligne.

```
npm start
```

## Liste des chaînes

`docs/channels.js` : les streamers du ZEVENT présents sur le plateau, classés par cagnotte, générés depuis l'API publique de zevent.fr. La version Node recharge la liste à chaque démarrage.

## Réglages de détection

Tout est dans `RULES` en tête de `docs/core.js` (et en constantes en tête de `tombola-watch.mjs`) : motifs d'annonce, délais de fin, répit, dédoublonnage.

Outil indépendant, non affilié au ZEVENT ni à Twitch. Pour donner : https://zevent.fr/don
