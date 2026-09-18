# Jev pour OpenCode

Sélectionne **Jev / jev**, **jev-free** ou **jev-go** dans `/models`, puis discute normalement. À chaque nouveau message, TypeSafe Jev estime une distribution **P(meilleur modèle pour cette demande)** sur les identifiants exacts du catalogue OpenCode. Le fournisseur sélectionné dans l'interface reste Jev.

| Choix | Candidats |
| --- | --- |
| `jev/jev` | Modèles gratuits Zen + Go si un compte Go est connecté |
| `jev/jev-free` | Modèles gratuits Zen uniquement |
| `jev/jev-go` | Modèles du catalogue Go ; connexion Go nécessaire |

Les modèles OpenAI et Anthropic sont exclus, même lorsqu'ils figurent dans Go. Le dépôt remplace les anciens lanceurs Claude Code/Codex de [jev-router](https://github.com/gargpratyush/jev-router).

## Installation depuis ce dépôt

Node.js 22+ et OpenCode compatible AI SDK v3 ; intégration vérifiée avec OpenCode 1.18.31.

```sh
git clone https://github.com/Loule95450/jev-free-router.git
cd jev-free-router
npm ci
node -e 'console.log(require("node:url").pathToFileURL(process.cwd() + "/src/plugin.mjs").href)'
```

Ajoute l'URL affichée à la liste `plugin` de ton `opencode.json` (global : `~/.config/opencode/opencode.json`). Conserve tes autres plugins et réglages :

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///chemin/vers/jev-free-router/src/plugin.mjs"],
  "model": "jev/jev"
}
```

Configure la clé du **cerveau TypeSafe** dans l'environnement qui lance OpenCode :

```sh
export JEV_API_KEY='ta-cle-typesafe'
opencode
```

Cette clé reste nécessaire pour obtenir les probabilités de Jev. Sans elle, le plugin signale un mode de secours, sans prétendre calculer des probabilités. Aucune clé Artificial Analysis n'est nécessaire par défaut. Pour Go, utilise `/connect` → **OpenCode Go**, ou `OPENCODE_GO_API_KEY`. La clé Zen existante est réutilisée si disponible ; les modèles publics gratuits peuvent fonctionner sans elle, selon la politique d'OpenCode.

Le plugin ajoute les trois modèles au démarrage. Aucun proxy à lancer, port à ouvrir ni liste de modèles à maintenir. Si tu utilises `enabled_providers`, ajoute `jev` à cette liste. Ne charge pas le même plugin à la fois via `plugin` et via `.opencode/plugins/`.

## Données dynamiques, sans note écrite dans le code

1. **Disponibilité** : catalogues officiels [Zen](https://opencode.ai/zen/v1/models) et [Go](https://opencode.ai/zen/go/v1/models). Zen contient aussi des modèles payants : Jev conserve les offres à coût nul connu ou les nouveaux IDs explicitement suffixés `-free`, sauf prix connu contradictoire.
2. **Contexte, capacités, coûts** : [models.dev/api.json](https://models.dev/api.json), sans clé. Les prix Go sont des coûts de consommation du quota ; ils ne sont pas présentés comme une facture supplémentaire. Le solde personnel du quota n'est pas disponible dans `/models`.
3. **Benchmarks** : [models.dev/models.json](https://models.dev/models.json), sans clé, avec les sources originales, versions, dates et conditions de test lorsqu'elles sont disponibles. Les mesures de fournisseurs et les évaluations indépendantes restent distinctes ; leurs scores ne sont pas fusionnés en un indice d'intelligence inventé.
4. **Snapshot GitHub** : `data/benchmarks.json`, également téléchargé indépendamment de la version du plugin. Une GitHub Action quotidienne actualise ce fichier. Les scores Artificial Analysis et les copies de ses benchmarks identifiées comme telles sont exclus du snapshot public par défaut.
5. **Artificial Analysis, optionnel** : `ARTIFICIAL_ANALYSIS_API_KEY` permet l'enrichissement par les évaluations de son API, avec cache local de 24 heures. Source : [Artificial Analysis](https://artificialanalysis.ai/).

Un nouveau modèle présent dans les catalogues live devient candidat dès leur prochaine vérification, sans release du plugin et sans attendre le snapshot GitHub. Une absence de benchmark est **inconnue**, jamais transformée en zéro. Les rapprochements utilisent les IDs exacts, insensibles à la casse, sans préfixe de fournisseur et sans suffixe `-free` ; aucun score d'une ancienne version n'est attribué à la suivante. Les correspondances ambiguës sont ignorées.

La « taille » en tokens est fournie par models.dev. Le nombre de paramètres n'est pas universellement publié et ne mesure pas l'intelligence. Avec `JEV_FETCH_PARAMETER_COUNTS=1`, Jev consulte aussi l'API publique Hugging Face pour les dépôts de poids liés par models.dev : nombre total de paramètres safetensors, cache de 7 jours. Pour les MoE, ce total n'est pas le nombre de paramètres actifs. Une valeur absente reste `null`.

## Décision probabiliste

Un seul appel System One contient un `Choice` sur les IDs exacts, accompagné de scores de complexité, raisonnement et outils. Jev reçoit le dernier message (maximum 24 000 caractères), un extrait récent de conversation (maximum 12 000 caractères), la taille estimée du contexte et les métadonnées des candidats. Aucun contenu n'est envoyé aux sources de benchmarks ; les requêtes de scores ne contiennent aucun prompt.

La distribution complète renvoyée par TypeSafe est validée et conservée. Un résultat incomplet ou invalide déclenche le secours. Les probabilités sont des **estimations du routeur**, pas une garantie ni des probabilités de réussite calibrées expérimentalement.

La sélection maximise `P(meilleur modèle) − poids_coût × coût_relatif_estimé`. Le poids vaut `0.02` par défaut : le prix influence les décisions proches, sans remplacer une forte préférence de qualité. `JEV_COST_WEIGHT=0` désactive ce facteur. Les coûts inconnus ne sont pas assimilés à la gratuité. La confiance globale, les probabilités et l'utilité après coût sont des champs distincts.

Les contextes connus trop petits et les incompatibilités connues d'outils sont filtrés. Pour une pièce jointe non textuelle, la modalité doit être connue comme supportée. Un nouveau modèle sans métadonnées reste éligible aux demandes textuelles, avec limites inconnues. Le SDK choisit le protocole indiqué par models.dev ; les SDK nommés OpenAI-compatible et Anthropic servent uniquement au transport vers **opencode.ai**, jamais vers ces fournisseurs.

Une décision reste fixe pendant les boucles d'outils et les reprises réseau d'un même message. Chaque nouveau message est réévalué ; les sessions et agents sont séparés. Les flux, outils, annulations et blocs de raisonnement passent par les SDK natifs. Si TypeSafe échoue, Jev garde le modèle précédent s'il est encore éligible, sinon prend le moins cher connu, avec indication explicite du secours et probabilités `null`.

## Cache et nombre d'appels

| Source | Actualisation | Secours en cas de panne |
| --- | --- | --- |
| Catalogues Zen / Go | Début de conversation, puis au plus une fois toutes les 5 min aux nouveaux messages | Dernier catalogue, jusqu'à 24 h |
| Métadonnées et benchmarks models.dev | 24 h | Cache jusqu'à 7 jours |
| Snapshot GitHub | 24 h | Cache jusqu'à 30 jours, puis snapshot livré |
| Artificial Analysis optionnel | 24 h | Cache jusqu'à 7 jours |
| Paramètres Hugging Face optionnels | 7 jours | Cache jusqu'à 30 jours |

Le cache persiste entre les redémarrages. Les requêtes simultanées vers la même source dans le processus sont mutualisées, les ETags sont réutilisés et un échec impose un délai avant nouvel essai. Deux processus démarrés simultanément avec un cache vide peuvent chacun effectuer un appel. Aucun score n'est rafraîchi pendant une boucle d'outils. Sans clé Artificial Analysis, **zéro appel** vers son API.

## Publier un cache commun

La workflow `.github/workflows/benchmarks.yml` actualise `data/benchmarks.json` sur `master` chaque jour, sans version npm. Elle doit être présente sur la branche par défaut du dépôt, avec Actions et l'écriture du bot autorisées. Les installations téléchargent le fichier public au maximum quotidiennement ; l'arrivée des modèles reste indépendante.

```sh
npm run benchmarks:sync
# Source alternative de mesures de code, couverture plus ancienne :
node scripts/sync-benchmarks.mjs aider
```

Pour partager des scores Artificial Analysis, ses [conditions](https://artificialanalysiscdn.com/legal/ProDataPlatformTerms.pdf) imposent un accord spécifique pour la redistribution de JSON. Après obtention de ce droit, configure dans GitHub :

- Secret `ARTIFICIAL_ANALYSIS_API_KEY` : clé du mainteneur.
- Variable `JEV_BENCHMARK_SOURCE=artificial-analysis`.
- Variable `AA_ALLOW_REDISTRIBUTION=1`.

La workflow effectue alors un appel quotidien pour l'ensemble des utilisateurs. La clé reste dans GitHub Secrets ; les utilisateurs lisent le snapshot public. Ne publie jamais la clé dans le dépôt. Le code et la workflow sont préparés ici ; leur présence locale n'active pas leur exécution sur GitHub.

## Configuration

| Variable | Rôle |
| --- | --- |
| `JEV_API_KEY` / `TYPESAFE_API_KEY` | Clé TypeSafe pour le routage |
| `OPENCODE_GO_API_KEY` | Remplace la clé Go stockée par OpenCode |
| `OPENCODE_API_KEY` | Remplace la clé Zen stockée par OpenCode |
| `ARTIFICIAL_ANALYSIS_API_KEY` | Enrichissement AA optionnel, cache 24 h |
| `JEV_COST_WEIGHT` | Facteur de coût entre 0 et 1 ; défaut `0.02` |
| `JEV_BENCHMARKS_URL` | URL HTTPS du snapshot commun ; défaut ce dépôt sur `master` |
| `JEV_FETCH_PARAMETER_COUNTS` | `1` pour activer les consultations Hugging Face |
| `JEV_CACHE_DIR` | Défaut `$XDG_CACHE_HOME/jev-opencode` ou `~/.cache/jev-opencode` |
| `JEV_AUTH_FILE` | Chemin alternatif du `auth.json` OpenCode |

Le format `OPENCODE_AUTH_CONTENT` et les clés déclarées dans la configuration des fournisseurs OpenCode sont également reconnus. Les clés ne sont jamais enregistrées dans le cache. Les fichiers `.env` ne sont pas chargés automatiquement par ce plugin.

Une notification indique le modèle réellement utilisé ; les logs OpenCode contiennent la distribution et les critères de décision, sans texte du prompt. Le budget de contexte affiché pour le fournisseur virtuel est conservateur (128k), les limites connues du modèle choisi étant revérifiées au moment de l'appel. L'estimation de tokens n'est pas un tokenizer propre à chaque modèle ; les limites restent contrôlées par le serveur OpenCode.

## Développement

```sh
npm ci
npm test
npm run test:opencode # nécessite le binaire OpenCode ; serveurs LLM simulés
npm pack --dry-run
```

Les tests couvrent les nouveaux modèles inconnus, les exclusions, les probabilités, les contraintes de contexte, le cache et les pannes, l'isolation des tours, le streaming et les outils via les SDK réels. Les tests n'utilisent aucune clé réelle et ne consomment pas de crédit d'inférence.

MIT, adaptation de jev-router. Voir `NOTICE` pour les sources de données et licences tierces.
