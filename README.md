# Heatwise

Pilotage intelligent de radiateurs pilotés par thermostat X2D (Delta Dore)
pour Home Assistant.

Développé et documenté dans le dépôt privé
[HA-perso](https://github.com/remicastaing/HA-perso). Ce dépôt est publié
automatiquement à chaque version (voir `CLAUDE.md` du dépôt privé).

## Statut

Une première implémentation (association matérielle, pièces/radiateurs,
programmation, régulation automatique) a été développée puis abandonnée :
le périmètre couvert par les user stories était trop large pour une
première itération. Voir
`specs/001-heatwise-heating-control-abandoned/STATUS.md` du dépôt privé.

L'itération `specs/002-heatwise-panel-pieces/` a reconstruit la première
brique visuelle : un panneau personnalisé affichant les pièces, avec
création de pièce depuis le panneau.

L'itération `specs/003-heatwise-ajout-radiateur/` a ajouté l'appairage
d'un radiateur au dongle RFPlayer et son pilotage manuel marche/arrêt. La
programmation et la régulation automatique (consigne de température) ne
sont pas encore implémentées.

Le protocole radio est documenté en détail dans `docs/rfplayer-x2d.md` du
dépôt privé (essais réels sur du matériel Delta Dore / RFPlayer).

## Installation

### Via HACS

1. Ajouter ce dépôt comme dépôt personnalisé HACS (catégorie « Intégration »).
2. Installer « Heatwise », puis redémarrer Home Assistant.
3. Paramètres → Appareils et services → Ajouter une intégration → Heatwise
   → renseigner le **port du dongle RFPlayer** (voir ci-dessous).

### Port du dongle RFPlayer

Le port est demandé à l'installation, et peut être modifié plus tard
depuis Paramètres → Appareils et services → Heatwise → **Reconfigurer**.
Deux formes sont acceptées :

- un chemin de périphérique série, par exemple `/dev/ttyUSB0` (dongle
  branché directement sur le Raspberry Pi) ;
- une URL réseau `socket://hôte:port`, utile en développement quand le
  dongle est branché sur un autre ordinateur et relayé par
  `dev/tools/rfplayer_bridge.py` du dépôt privé (ex.
  `socket://mon-mac:4000`).

Une installation qui date d'avant cette itération (aucun port renseigné)
continue de fonctionner : le panneau et les pièces restent disponibles,
seul l'ajout ou le pilotage d'un radiateur nécessite de renseigner le
port au préalable (via « Reconfigurer »).

## Configuration

Toute la configuration se fait depuis le panneau **Heatwise** de la barre
latérale (jamais depuis les paramètres de l'intégration, hors port du
dongle ci-dessus) :

1. **Créer une pièce** avec le bouton « + Créer une pièce » — une pièce
   Heatwise est directement une Zone Home Assistant (Paramètres → Zones).
2. **Associer une sonde** (température et humidité) : bouton
   « + Thermomètre » du pavé d'une pièce sans sonde → choisir un capteur
   de température parmi ceux de Home Assistant (la sonde doit d'abord
   être appairée, par exemple via ZHA) ; le capteur d'humidité du même
   appareil est présélectionné → « Associer ». L'association est
   enregistrée dans les réglages natifs de la Zone (Paramètres → Zones),
   et l'appareil de la sonde est rangé dans la pièce. Une sonde déjà
   associée à une pièce n'est pas proposée pour une autre. Le pavé
   affiche ensuite la température et l'humidité en direct ; il indique
   « Sonde indisponible » si Home Assistant la déclare indisponible ou
   si aucune mesure n'est arrivée depuis plus d'une heure, et une icône
   de pile faible à 20 % ou moins. La section « Sonde » des paramètres
   de la pièce permet de la changer ou de la dissocier. Une sonde choisie
   directement dans Paramètres → Zones est prise en compte de la même
   façon.

   **Sonde neuve (Zigbee, ZHA)** : dans la même fenêtre, « Appairer une
   nouvelle sonde » ouvre le réseau Zigbee 3 minutes et affiche la
   manipulation à faire sur la sonde. Dès que la sonde a rejoint le
   réseau et que ses capteurs existent, elle est associée
   automatiquement à la pièce (température et, s'il existe, humidité) ;
   elle garde le nom donné par Home Assistant. « Arrêter » ou fermer la
   fenêtre referme le réseau. Un appareil qui ne mesure pas la
   température reste dans Home Assistant sans être associé. Le bouton
   n'apparaît que si l'intégration ZHA est chargée. Limite connue : la
   détection s'appuie sur un message interne de ZHA, à revérifier après
   une mise à jour majeure de Home Assistant.
3. **Ajouter un radiateur** : bouton « + Radiateur » (sur le pavé d'une
   pièce sans radiateur, ou depuis ses paramètres) →
   1. mettre le récepteur du radiateur en attente d'appairage (le message
      affiché décrit la manipulation et prévient que cela remplace tout
      thermostat qui pilote actuellement ce radiateur) → « C'est fait » ;
   2. vérifier que le voyant TH du récepteur passe au vert fixe, puis
      « Appairage réussi » (ou « Réessayer »/« Abandonner » sinon) ;
   3. ajuster le nom proposé par défaut (« <pièce> n°x ») si besoin, puis
      « Enregistrer ».
4. Le bouton « paramètres » (icône ⚙) de chaque pièce liste ses
   radiateurs, chacun avec une icône indiquant s'il chauffe. Cliquer sur
   l'icône allume ou éteint manuellement ce radiateur ; une chauffe
   manuelle s'arrête automatiquement après 1 h.
5. Un bouton dans la barre d'outils permet de basculer l'affichage entre
   pavés et liste ; le choix est mémorisé par navigateur.

## Entités exposées

Aucune : les radiateurs sont pilotés uniquement depuis le panneau
Heatwise (pas d'entité `switch`/`climate`), conformément au choix acté
pour cette itération (cf. `research.md` de la spec 003 — à réévaluer si
une itération future a besoin d'automatisations ou de cartes Lovelace).

## Sécurité

- Le récepteur X2D coupe lui-même le chauffage s'il ne reçoit plus aucun
  ordre pendant une heure : une chauffe manuelle est donc de toute façon
  limitée à 1 h par Heatwise (arrêt explicite envoyé, sans compter
  uniquement sur cette sécurité matérielle).
- Au démarrage de Home Assistant, tous les radiateurs déjà enregistrés
  reçoivent un ordre d'arrêt, quel que soit leur état avant l'arrêt.
- Si le dongle RFPlayer est injoignable, aucun radiateur n'est ajouté et
  aucun ordre de chauffe/arrêt n'est considéré comme appliqué : un
  message d'erreur clair est affiché dans le panneau.
