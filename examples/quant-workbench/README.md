# SignalBook

SignalBook compares personal time series in one dohc Collection. It loads 5,475 synthetic observations across eight health and portfolio series when you first open an empty workbench. Each series has one reading a day, except portfolio value, which has one every three hours.

## Open the workbench

Copy this folder to the root of a dohc workspace as `quant-workbench`. Use the Apps review to open it, or run `dohc_publish_app` with `action: "stage"` and `appRoot: "quant-workbench"`. Review the app and Collection together, then approve the staged change and open the app.

The left rail lists series with their latest reading, the change in the 7-day average against the 7 days before, and a 30-day sparkline. It loads 100 series at a time and always includes the plotted ones. With more than 20 series, use **Find a series** to search by name, slug, or domain. Choose **L** to plot a series on the left axis and **R** to compare it on the right axis. Choose a pressed **R** again to plot one series.

Hover the chart or focus it and use the arrow keys to read each bucket in the panel at the top left. Drag across the chart to zoom, and double-click or choose **Back to** the preset (for example **Back to 90D**) to return. On a touch screen, drag to move the crosshair and tap to pin a reading. Choose the keyboard button or press **?** to see every shortcut. You can turn off single-key shortcuts there, and the choice is saved in the Collection.

| Key                   | Action                                      |
| --------------------- | ------------------------------------------- |
| 1, 2, 3, 4            | 30D, 90D, 1Y, All                           |
| D, W, M               | Day, week, or month buckets                 |
| Z                     | Back to the preset range                    |
| [ and ]               | Move the lag by one day                     |
| N                     | Open or close research notes                |
| I                     | Open or close CSV import                    |
| ?                     | Show or hide this list                      |
| Left and Right arrows | Move through the chart one bucket at a time |
| Shift with an arrow   | Move 10 buckets                             |
| Home and End          | First or last bucket                        |
| Esc                   | Clear the reading or close the open panel   |

## Import a CSV

Choose **Import CSV** and drop or select a UTF-8 file. Use these columns.

```csv
series,observed_at,value,name,unit,domain,tags_json
sleep-hours,2026-08-01,7.25,Sleep duration,h,Health,"{""device"":""watch""}"
resting-hr,2026-08-01T06:00:00+08:00,58,Resting heart rate,bpm,Health,{}
```

`series`, `observed_at`, and `value` are required. Use lowercase slugs with letters, digits, hyphens, or underscores. Dates start at midnight UTC. Timestamps need `Z` or an explicit offset. The first row for a new slug supplies its optional name, unit, and domain. Optional tags must be JSON objects.

SignalBook reserves slugs that start with `sample-` for the synthetic series.

SignalBook validates the entire file before sending rows, identifies it by its SHA-256, and commits chunks in order. `importChunk` uses the owner-only bulk profile, so the CLI and MCP can commit up to 8,192 rows per request. Charts count the rows once the whole batch arrives. If an import stops, choose the same file again to resume. Each changed file creates a new batch. If you export the same series twice, import only the newly exported rows to avoid counting the overlap twice.

## Read the analysis

Buckets use UTC dates, Mondays, or calendar months. Wide ranges use coarser buckets when needed. The chart plots each bucket's mean. On hover or keyboard focus it shows the count, open, high, low, and close when a bucket holds more than one reading, and the sum for additive units such as steps, shares, and AU. Rolling means average the days with data in the preceding 7 or 30 calendar days, including the bucket's last day. Saved snapshots compute rolling means from days inside their range only, so a shared report never reflects readings outside the range it names. A saved snapshot and its note can take up to 248 KiB, so a report always fits in one read. The report's change column compares the first 7-day average that fits inside the range with the last one, and needs at least 14 days so the two weeks don't overlap.

Pearson r compares days with data in both series, and needs at least 10 paired days and two series that both vary; otherwise the operations return no r. With a lag of +2 days, the workbench pairs each left-series day with the right-series day two days later. The lag profile shows r for every lag from −30 to +30 days and marks the strongest one. Choose a bar or drag the lag slider to move between lags. The 95% interval uses the Fisher z-transform on an effective sample size. Daily values carry over from one day to the next, so the workbench shrinks n by the product of the two series' lag-1 autocorrelations, n × (1 − ρ) / (1 + ρ), and shows the result as "independent" days. The label names the size of r only when that interval excludes zero. The peak is the strongest of the supported lags, those with at least two-thirds of the most paired days and at least 10, so treat its interval as optimistic. The scatter plot samples wide ranges, and the statistics use every pair in the range. When both series trend over the range, each correlating with time at |r| of 0.3 or more, the panel also shows r with each series' straight-line trend removed (the partial correlation given time), so a shared drift is not mistaken for a relationship.

Outliers are readings far from their series' trailing 30-day average, the mean of the daily means over the 30 days before the reading. A reading needs at least 7 days with data in that window, so the first week of a series is never scored against one or two days. The workbench subtracts the series' average gap in the selected range, then divides by the standard deviation of the gaps. Because z compares each gap with the others in the selected range, zooming into a stretch can change which readings stand out, and the panel says "in this range". A reading is an outlier when the result is beyond ±2. The **vs expected** column shows the same centered gap, so its sign always matches z. Scoring against a moving baseline keeps a steady trend from flagging its own highs and lows. Choose an outlier to mark its reading on the chart.

## Share a snapshot

1. In a workspace connected to a relay, use `dohc_publish_app` with `action: "createLink"`, `appRoot: "quant-workbench/report"`, `access: "view"`, and a fresh UUID in `operationId`. dohc does not show a link's full grant ID on screen yet, so this step needs an agent or the CLI.
2. Choose **Share**, then pick the saved snapshot. Enter the returned `grantId` under **Report link grant ID** and choose **Link report**.
3. Publish the report app on that link. In dohc, open the report app, choose **Publish on a share link**, pick the link, approve it, and choose **Copy app link**. An agent can instead use `action: "prepare"` with the returned `shareId` and `grantId`, approve, and insert the returned `appQuery` before the link URL's fragment.
4. Open the app link in a browser and choose **Open app**.

Each link serves the one snapshot assigned to its grant. The report includes the note, frozen rollups and key figures for its selected series, and the correlation saved with the snapshot. **Withdraw report** clears that assignment, and **Undo** restores it. Keep the link URL private until you're ready to share it.

## Run the checks

From the repository root, run the Collection host tests. They import a 23,360-row CSV and check rollups, correlation, outliers, report access, and the formatting helpers.

```sh
pnpm --filter @dohc/app-backend-runtime exec vitest run src/quant-workbench-example.test.ts
```

To run the browser checks against the desktop build, use the repository's Playwright browser setup, then run these commands.

```sh
pnpm qa:prepare
pnpm exec playwright test --config examples/quant-workbench/playwright.config.ts
```
