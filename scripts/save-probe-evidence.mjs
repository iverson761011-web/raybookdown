import fs from 'node:fs/promises';
const root='https://api.github.com/repos/iverson761011-web/raybookdown/contents/';
const branch='codex/weekly-recommendations';
const headers={Accept:'application/vnd.github.object+json',Authorization:'Bearer '+process.env.GITHUB_TOKEN,'X-GitHub-Api-Version':'2022-11-28'};
try {
  for(const name of ['recommendation-evidence.json','recommendation-history.json','team-week-schedule.json']) {
    const file='data/'+name,bytes=await fs.readFile(file);
    if(bytes.length>(name==='recommendation-history.json'?8388608:1048576))throw Error('Size');
    JSON.parse(bytes);
    const metadata=await fetch(root+file+'?ref='+encodeURIComponent(branch),{headers});
    if(!metadata.ok&&metadata.status!==404)throw Error('Read');
    const sha=metadata.ok?(await metadata.json()).sha:null;
    const body={message:'Save public NBA evidence for review',branch,content:bytes.toString('base64'),...(sha?{sha}:{})};
    const response=await fetch(root+file,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!response.ok)throw Error('Write');
    console.log(JSON.stringify({PublicFile:name,Bytes:bytes.length,Saved:true}));
  }
} catch { console.error(JSON.stringify({ErrorType:'PublicProbeSaveFailed'}));process.exitCode=1; }
