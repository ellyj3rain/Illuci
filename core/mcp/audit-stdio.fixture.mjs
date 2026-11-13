import { mock } from 'node:test';
import { join } from 'node:path';
if(!process.env.ILLUCI_HOME||!process.env.ILLUCI_AUDIT_FIXTURE_DIR)throw Error('Isolated fixture roots required');
const home={ILLUCI_HOME_LEAF:'.illuci',resolveIlluciHomeDir:(...parts)=>join(process.env.ILLUCI_HOME,...parts)};
mock.module(new URL('../agents/home-dir.js',import.meta.url).href,{namedExports:home,defaultExport:home});
mock.module(new URL('../bridges/env-load.js',import.meta.url).href,{namedExports:{loadBridgeEnv:()=>({loaded:false,keys:[]})}});
const {registerSchema}=await import('./schema-registry.js');
const {serveStdio}=await import('./server.js');
let calls=0;
if(process.env.ILLUCI_AUDIT_FIXTURE_MODE==='attempt')process.env.ILLUCI_DECISIONS_FILE=process.env.ILLUCI_AUDIT_FIXTURE_DIR;
registerSchema({name:'audit_fixture_v1',schema_version:'1.0.0',kind:'tool',definition:{
  description:'Disposable audit transport control',inputSchema:{type:'object',properties:{},additionalProperties:false},
  handler:async()=>{
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'fixture/action-observed',params:{calls:++calls}})+'\n');
    process.env.ILLUCI_DECISIONS_FILE=process.env.ILLUCI_AUDIT_FIXTURE_DIR;
    return {fixtureResult:true};
  },
}});
await serveStdio({tenantId:'audit-wire-fixture'});
