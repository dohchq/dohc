export function createTypingQuitRecovery(dependencies:{hasWindows:()=>boolean;unresolved:()=>boolean;flush:()=>Promise<void>;confirmLoss:()=>Promise<boolean>;quit:()=>void;beforeQuit:(event:{preventDefault():void})=>void}) {
 let approved=false;let pending=false;
 return {beforeQuit(event:{preventDefault():void}):void {
  if(approved){approved=false;dependencies.beforeQuit(event);return;}
  if(dependencies.hasWindows() || !dependencies.unresolved()){dependencies.beforeQuit(event);return;}
  event.preventDefault();if(pending)return;pending=true;
  void dependencies.flush().then(()=>true,()=>dependencies.confirmLoss()).then(continueQuit=>{if(continueQuit){approved=true;dependencies.quit();}}).catch(()=>undefined).finally(()=>{pending=false;});
 }};
}
