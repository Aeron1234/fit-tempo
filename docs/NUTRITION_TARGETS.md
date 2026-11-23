# Nutrition targets

Open **Goals → Nutrition targets**. Enter daily calorie and macro targets directly, or confirm your height, latest recorded weight, age, activity and equation inputs to estimate them. Changing measurements here only changes the estimate. Review and edit the proposed targets, then confirm the save. A newer weight can help you generate a new estimate while the saved targets remain active.

## Calculation

- Mifflin–St Jeor estimates resting energy in kcal/day using 10 × kg + 6.25 × cm − 5 × years, plus 5 or minus 161 for the equation's male and female branches. Its study covered healthy adults aged 19–78. [Original equation](https://pubmed.ncbi.nlm.nih.gov/2305711/)
- Fit Tempo multiplies resting energy by 1.55, 1.85, or 2.10 as approximations for the FAO light, moderate, and vigorous activity categories. Activity is based on the whole day. [FAO activity ranges](https://www.fao.org/4/Y5686e/y5686e07.htm)
- Fit Tempo uses 0%, +5%, and −10% adjustments for maintenance, muscle gain with resistance training, and weight loss. These are editable product defaults informed by the small-surplus and energy-restriction literature. Individual outcomes vary. [Surplus study](https://pmc.ncbi.nlm.nih.gov/articles/PMC10620361/) · [Energy-restriction trial](https://pubmed.ncbi.nlm.nih.gov/17200169/)
- The editable starting split is 25% protein, 45% carbohydrate, and 30% fat. These percentages fall within the adult reference ranges. The estimate rounds calories to the nearest kcal and macro grams separately using 4, 4, and 9 kcal/g. [Adult reference ranges](https://www.ncbi.nlm.nih.gov/books/NBK56068/?report=printable)

The estimator is for generally healthy adults aged 19–78. Use manual targets during pregnancy, breastfeeding, or when following a clinical nutrition plan. The estimator accepts 100–250 cm and 30–300 kg, skips BMI below 18.5 and weight-loss estimates below BMI 25, and skips estimates outside 1,400–6,000 kcal/day. These are feature boundaries. The estimate stays in the browser and sends only confirmed target values to Fit Tempo.

## Storage and progress

Migration 016 adds owner-scoped target revisions. A saved revision takes effect on the account's local date. Same-day edits use the highest revision for that date. Progress shows that day's recorded subtotal and coverage in kcal or grams. A partial subtotal has missing values, an unknown total has no usable values for that nutrient, and an unrecorded day differs from a confirmed zero.

Set up a disposable local PostgreSQL database whose name ends in `_test`, using the existing PostgreSQL connection settings. Run the following from the repository root, then set `TEST_DATABASE_URL` to that local database for the integration test.

```powershell
.\database\migrate.ps1 -Database fit_tempo_nutrition_test
npm.cmd run build
node --test apps/api/test/nutrition-targets.integration.mjs
```

See the [PostgreSQL setup guide](PHASE05_POSTGRES.md) and [implementation status](IMPLEMENTATION_STATUS.md) for verification evidence.
