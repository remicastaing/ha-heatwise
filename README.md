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
d'un radiateur au dongle RFPlayer et son pilotage manuel marche/arrêt.
Les itérations suivantes ont ajouté la programmation (spec 005), les
sondes (specs 006 et 007) puis la régulation automatique de chaque pièce
(`specs/008-heatwise-regulation-auto/`), puis le renommage et la
suppression d'une pièce depuis le panneau
(`specs/009-heatwise-renommer-supprimer-piece/`), l'historique
des températures et de l'hygrométrie
(`specs/010-heatwise-historique-mesures/`), et enfin la chauffe 1 h d'une
pièce, l'affichage de la version et des mises à jour, et le renvoi des
ordres toutes les 5 min (`specs/011-heatwise-panneau-maj-chauffe/`).

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
   température reste dans Home Assistant sans être associé. Si ZHA
   termine la configuration d'une sonde sans créer ses capteurs (cas
   fréquent avec les sondes sur pile qui se réannoncent pendant leur
   configuration), Heatwise recharge l'intégration ZHA une fois — les
   appareils Zigbee sont indisponibles quelques secondes — puis associe
   la sonde. Le bouton
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

   **Chauffer 1 h** : le bouton « Chauffer 1 h » en pied de pavé (ou sur
   la ligne, en affichage liste) met en chauffe tous les radiateurs de la
   pièce et suspend sa régulation ; le pavé affiche « Chauffe manuelle
   jusqu'à HH:MM ». Un nouvel appui relance l'heure ; « Arrêter la
   chauffe » y met fin aussitôt. À l'échéance, les radiateurs reçoivent
   un ordre d'arrêt et la pièce reprend son fonctionnement normal. La
   chauffe est acceptée même si la sonde est indisponible ou en mode
   vacances ; un redémarrage de Home Assistant l'annule.
5. **Régulation automatique** : toute pièce qui a au moins un radiateur
   et une sonde est régulée, sans réglage à activer. Ses radiateurs
   chauffent quand la température mesurée passe sous « consigne −
   0,3 °C » et s'arrêtent dès que la consigne est atteinte (consigne
   courante de la programmation). Le pavé indique l'état : « Chauffe »,
   « Consigne atteinte », « Régulée », « Arrêt de sécurité » (avec la
   raison), « Régulation suspendue (manuel) jusqu'à HH:MM » ou « Non
   régulée ». Une action manuelle sur un radiateur suspend la régulation
   de toute la pièce pendant 1 h. Une pièce sans sonde n'est jamais
   chauffée par la régulation.
6. L'en-tête du panneau affiche la **version** de Heatwise et regroupe
   les actions générales ; un bouton y bascule l'affichage entre pavés et
   liste (choix mémorisé par navigateur).

   **Mises à jour** : si Heatwise est installé via HACS et qu'une version
   plus récente est disponible, un bandeau l'indique sous l'en-tête, avec
   le lien vers les notes de version et un bouton « Mettre à jour »
   (après confirmation). Une fois la version installée, le bandeau
   propose de redémarrer Home Assistant. Sans HACS, seule la version
   s'affiche.
7. **Renommer une pièce** : section « Pièce » des paramètres de la pièce
   → modifier le nom → « Renommer ». La Zone Home Assistant est renommée
   (Paramètres → Zones affiche le même nom) ; radiateurs, programmation
   et sonde ne changent pas, aucun appareil n'est renommé. Un nom vide
   ou déjà porté par une autre pièce (casse et espaces ignorés) est
   refusé.
8. **Supprimer une pièce** : bouton « Supprimer la pièce » en bas de ses
   paramètres. Tant que la pièce a des radiateurs, la suppression est
   refusée : supprimez-les d'abord (icône corbeille, qui éteint puis
   dissocie chaque récepteur). Sinon, une confirmation récapitule ce qui
   disparaît : la Zone et la programmation de la pièce sont supprimées ;
   la sonde reste dans Home Assistant, sans zone. Aucun ordre radio
   n'est envoyé.

   **Pièce supprimée dans Paramètres → Zones** : Heatwise éteint ses
   radiateurs (nouvel essai chaque minute si le dongle est injoignable),
   efface sa programmation et la retire de la régulation. Les radiateurs
   ne sont pas dissociés automatiquement : ils apparaissent dans
   l'encart « Radiateurs sans pièce » de la vue principale, d'où on les
   supprime (arrêt puis dissociation). Un radiateur sans pièce ne
   chauffe jamais. Une pièce recréée ensuite sous le même nom part
   vierge.

   L'historique d'une pièce supprimée est conservé mais n'est plus
   consultable ; une pièce recréée sous le même nom repart avec un
   historique vide.
9. **Historique** : icône « courbe » du pavé, ou bouton « Historique »
   des paramètres de la pièce. Le graphique montre la température et
   l'humidité mesurées, la consigne (en pointillés) et, en fond, les
   périodes de chauffe, de régulation suspendue, d'arrêt de sécurité ou
   de pièce non régulée, sur 24 h, 7 jours ou 30 jours. Toucher ou
   survoler la courbe affiche les valeurs et l'état à cet instant. Une
   sonde indisponible, muette depuis plus d'1 h, ou Home Assistant
   arrêté laissent un trou : aucune valeur n'est inventée.

   Chaque point est la moyenne des mesures valables reçues pendant
   l'intervalle. La fréquence d'enregistrement se règle dans les
   paramètres Heatwise (icône ⚙ de la barre d'outils) : de 1 à 60 min,
   10 min par défaut, prise en compte immédiatement. L'historique est
   conservé sans limite de durée dans `heatwise_history.db` (dossier de
   configuration de Home Assistant, inclus dans ses sauvegardes) :
   environ 1 Mo par pièce et par an à 10 min, dix fois plus à 1 min.

## Entités exposées

Aucune : les radiateurs sont pilotés uniquement depuis le panneau
Heatwise (pas d'entité `switch`/`climate`), conformément au choix acté
pour cette itération (cf. `research.md` de la spec 003 — à réévaluer si
une itération future a besoin d'automatisations ou de cartes Lovelace).

## Sécurité

- Le récepteur X2D coupe lui-même le chauffage s'il ne reçoit plus aucun
  ordre pendant une heure. Heatwise limite toute chauffe manuelle à 1 h
  après la dernière action (arrêt explicite envoyé à l'échéance). Pendant
  cette heure, l'ordre de chauffe est renvoyé toutes les 5 min pour
  rattraper une trame perdue ; conséquence acceptée : si Heatwise cessait
  d'émettre juste après un renvoi, la coupure matérielle n'interviendrait
  qu'une heure plus tard (environ 2 h de chauffe au pire).
- Au démarrage de Home Assistant, tous les radiateurs déjà enregistrés
  reçoivent un ordre d'arrêt, quel que soit leur état avant l'arrêt ; la
  régulation reprend ensuite pièce par pièce, sur des mesures valides.
  Au déchargement de l'intégration, la régulation s'arrête et les
  radiateurs reçoivent un ordre d'arrêt.
- Régulation : arrêt de sécurité dès que la sonde est indisponible,
  inconnue, non numérique ou muette depuis plus d'une heure ; l'ordre
  courant de chaque radiateur (marche comme arrêt, y compris pour les
  pièces sans sonde et les radiateurs sans pièce, qui reçoivent l'arrêt)
  est renvoyé toutes les 5 min, bien avant la coupure matérielle d'1 h,
  ce qui rattrape les trames perdues en moins de 6 min. Limite acceptée : une sonde défaillante qui envoie
  régulièrement une valeur trop basse ferait chauffer la pièce.
- Si le dongle RFPlayer est injoignable, aucun radiateur n'est ajouté et
  aucun ordre de chauffe/arrêt n'est considéré comme appliqué : un
  message d'erreur clair est affiché dans le panneau.
