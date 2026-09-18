# Instructions du projet Jev

- Pour tout travail sur TypeSafe, System One, Jev ou ses questions de routage, lire et appliquer la skill `.agents/skills/typesafe-ai/SKILL.md`. Consulter les pages pertinentes de la documentation officielle actuelle comme elle le demande.
- Conserver les catalogues et les benchmarks dynamiques. Ne pas attribuer de score de qualité fixe à une famille ou une version de modèle. Un benchmark manquant reste inconnu ; il ne devient pas zéro.
- Conserver la distribution TypeSafe complète et distinguer probabilités, confiance et politique de coût. Les calculs déterministes et les contraintes de capacités restent dans le code.
- Après une modification du routage, exécuter `npm test`. Pour une modification de l'intégration OpenCode ou des transports, exécuter aussi `npm run test:opencode` avec ses réponses LLM simulées.
