export function buildRustCheckReport(results, { stamp, platform, arch }) {
  const verdict = results.some(
    (result) =>
      result.status === "FAIL" ||
      (result.required && result.status === "SKIP"),
  )
    ? "FAIL"
    : "PASS";

  const summary = results
    .map(
      (result) =>
        `  ${result.status.padEnd(4)} ${result.name}${
          result.reason ? ` — ${result.reason}` : ""
        }`,
    )
    .join("\n");
  const evidenceSummary = results
    .map(
      (result) =>
        `${result.name}=${result.status}${
          result.reason ? `[${result.reason}]` : ""
        }`,
    )
    .join(" ");

  return {
    summary,
    evidence: `- ${stamp} | run-rust-checks | ${platform}/${arch} | ${verdict} | ${evidenceSummary}`,
    verdict,
    exitCode: verdict === "FAIL" ? 1 : 0,
  };
}
