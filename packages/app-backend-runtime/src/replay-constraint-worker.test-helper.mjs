import {DatabaseSync,constants} from 'node:sqlite';
import {pathToFileURL} from 'node:url';

const entry=process.env.DOHC_TEST_REPLAY_ENTRY,revision=Number(process.env.DOHC_TEST_REPLAY_REVISION);
if(!entry||!Number.isSafeInteger(revision)||revision<0)throw Error('A replay fixture needs its worker and revision.');
const apply=DatabaseSync.prototype.applyChangeset;
let injected=false;
DatabaseSync.prototype.applyChangeset=function(changeset,options){
  if(!injected&&this.prepare("SELECT 1 FROM sqlite_schema WHERE name='dohc_applied'").get()
    &&this.prepare('SELECT revision FROM dohc_applied WHERE id=1').get().revision===revision){
    injected=true;
    if(options.onConflict(constants.SQLITE_CHANGESET_CONSTRAINT)!==constants.SQLITE_CHANGESET_ABORT)throw Error('Expected a constraint abort.');
    return false;
  }
  return apply.call(this,changeset,options);
};
await import(pathToFileURL(entry).href);
