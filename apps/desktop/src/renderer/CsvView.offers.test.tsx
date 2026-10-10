// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CsvView } from "./CsvView";
import { SharedLocalDocument } from "./sharedLocalDocument";
afterEach(cleanup);
describe("CSV offer observer", () => {
  it("uses parsed data rows and requires explicit workspace-file provenance", () => {
    const onCsvBoundOffer = vi.fn();
    const props = { workspaceId: "one", path: "data.csv", body: "Name\n" + Array.from({length:501}, (_,i)=>"row"+i).join("\n"),
      contentHash: "hash", contentRequestId: 1, contentReadTicket: 1, latestContentRequestId: 1,
      refreshAfterConflict: vi.fn(), switchReadPending: false, switchUnresyncedRef: {current:false},
      readOnly: true, localBuffer: new SharedLocalDocument("csv-offer"), onCsvBoundOffer };
    const rendered = render(<CsvView {...props} />);
    expect(onCsvBoundOffer).toHaveBeenLastCalledWith(null);
    rendered.rerender(<CsvView {...props} csvSource="workspace-file" />);
    expect(onCsvBoundOffer).toHaveBeenLastCalledWith({kind:"csv-bound",workspaceId:"one",path:"data.csv",cap:500,totalRows:501,plainWorkspaceCsv:true});
    onCsvBoundOffer.mockClear();
    rendered.rerender(<CsvView {...props} workspaceId="two" csvSource="workspace-file" />);
    expect(onCsvBoundOffer.mock.calls[0]).toEqual([null]);
    expect(onCsvBoundOffer).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "two" }));
    rendered.rerender(<CsvView {...props} csvSource="received-share" />);
    expect(onCsvBoundOffer).toHaveBeenLastCalledWith(null);
    rendered.rerender(<CsvView {...props} csvSource="workspace-file" />);
    onCsvBoundOffer.mockClear();
    rendered.unmount();
    expect(onCsvBoundOffer).toHaveBeenCalledExactlyOnceWith(null);
  });
});
