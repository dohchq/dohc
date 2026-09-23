// @vitest-environment jsdom
import { act,fireEvent,render,screen,cleanup } from "@testing-library/react";
import { afterEach,expect,it,vi } from "vitest";
import type { DatasetRecoveryPreparation } from "@dohc/cli/dataset";
import { CollectionRecoveryRestoreDialog } from "./CollectionRecoveryRestoreDialog";
afterEach(cleanup);
const recovery={transferId:"restore",manifestSha256:"a".repeat(64),sourceCursor:{datasetId:"dataset"},revision:{definition:{name:"Registrations"}}} as DatasetRecoveryPreparation;
it("requires old-host acknowledgement after archive review, then reports successful restore",async () => {
 const onRestore=vi.fn(async()=>{}),onRestored=vi.fn(),onClose=vi.fn();
 render(<CollectionRecoveryRestoreDialog onPrepare={async()=>recovery} onRestore={onRestore} onDiscard={async()=>{}} onRestored={onRestored} onClose={onClose} onError={vi.fn()}/>);
 await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Choose recovery file"}));});
 expect(screen.getByText("Registrations")).toBeTruthy();
 expect(screen.getByRole("button",{name:"Restore Collection"}).hasAttribute("disabled")).toBe(true);
 fireEvent.click(screen.getByRole("checkbox"));
 await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Restore Collection"}));});
 expect(onRestore).toHaveBeenCalledOnce();expect(onRestored).toHaveBeenCalledWith(recovery);expect(onClose).toHaveBeenCalledOnce();
});
it("discards a prepared archive when cancelled and ignores a late response after unmount",async()=>{
 let done!:(value:DatasetRecoveryPreparation)=>void;const onDiscard=vi.fn(async()=>{}),onRestored=vi.fn();
 const view=render(<CollectionRecoveryRestoreDialog onPrepare={()=>new Promise(resolve=>{done=resolve;})} onRestore={async()=>{}} onDiscard={onDiscard} onRestored={onRestored} onClose={vi.fn()} onError={vi.fn()}/>);
 fireEvent.click(screen.getByRole("button",{name:"Choose recovery file"}));view.unmount();
 await act(async()=>{done(recovery);});expect(onDiscard).toHaveBeenCalledWith("restore");expect(onRestored).not.toHaveBeenCalled();
});
