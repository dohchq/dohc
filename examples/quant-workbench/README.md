# SignalBook

SignalBook compares personal time series in one dohc Collection. It loads 23,360 synthetic observations across eight health and portfolio series when you first open an empty workbench.

## Open the workbench

Copy this folder to the root of a dohc workspace as `quant-workbench`. Use the Apps review to open it, or run `dohc_publish_app` with `action: "stage"` and `appRoot: "quant-workbench"`. Review the app and Collection together, then approve the staged change and open the app.

Compare **Sleep duration** and **Resting heart rate** at a lag of **+2 days**. Drag across the time-series chart to narrow the range, or enter dates below it. Focus the chart and use the arrow keys to inspect each bucket. Save a note to keep the selected date range and rollups as a snapshot.

## Import a CSV

Choose **Import CSV** and drop or select a UTF-8 file. Use these columns.

```csv
series,observed_at,value,name,unit,domain,tags_json
sleep-hours,2026-08-01,7.25,Sleep duration,h,Health,"{""device"":""watch""}"
resting-hr,2026-08-01T06:00:00+08:00,58,Resting heart rate,bpm,Health,{}
```

`series`, `observed_at`, and `value` are required. Use lowercase slugs with letters, digits, hyphens, or underscores. Dates start at midnight UTC. Timestamps need `Z` or an explicit offset. The first row for a new slug supplies its optional name, unit, and domain. Optional tags must be JSON objects.

SignalBook reserves slugs that start with `sample-` for the synthetic series.

SignalBook validates the entire file before sending rows, identifies it by its SHA-256, and commits chunks in order. Charts count the rows once the whole batch arrives. If an import stops, choose the same file again to resume. Each changed file creates a new batch. If you export the same series twice, import only the newly exported rows to avoid counting the overlap twice.

## Read the analysis

Buckets use UTC dates, Mondays, or calendar months. Wide ranges use coarser buckets when needed. The chart plots each bucket's mean and shows open, high, low, close, sum, and count on hover or keyboard focus. Rolling means average the days with data in the preceding 7 or 30 calendar days, including the bucket's last day.

Pearson r compares days with data in both series. With a lag of +2 days, the workbench pairs each left-series day with the right-series day two days later. The scatter plot samples wide ranges and the statistics use every pair in the range. Outliers use each series' population standard deviation over the selected range.

## Share a snapshot

1. In a workspace connected to a relay, use `dohc_publish_app` with `action: "createLink"`, `appRoot: "quant-workbench/report"`, `access: "view"`, and a fresh UUID in `operationId`.
2. Open the saved snapshot in SignalBook. Enter the returned `grantId` under **Report link grant ID** and choose **Link report**.
3. Prepare the report app with `action: "prepare"`, the report app root, and the returned `shareId` and `grantId`. Approve that publication.
4. Insert the returned `appQuery` before the link URL's fragment. Open the link in a browser and choose **Open app**.

Each link serves the one snapshot assigned to its grant. The report includes the note and frozen rollups for its selected series. **Withdraw report** clears that assignment. Keep the link URL private until you're ready to share it.

## Run the checks

From the repository root, run the host test and benchmark.

```sh
pnpm --filter @dohc/app-backend-runtime build
pnpm exec vitest run --reporter=verbose --silent=false examples/quant-workbench/workbench.test.ts
```

To run the browser checks against the desktop build, use the repository's Playwright browser setup, then run these commands.

```sh
pnpm qa:prepare
pnpm exec playwright test --config examples/quant-workbench/playwright.config.ts
```
