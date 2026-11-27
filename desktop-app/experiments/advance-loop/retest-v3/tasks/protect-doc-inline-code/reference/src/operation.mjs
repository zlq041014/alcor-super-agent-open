export function execute(v) {
  const rows=v.text.split(/(\r\n|\n|\r)/);let fence=false;
  for(let i=0;i<rows.length;i+=2){const line=rows[i];if(/^\s*```/.test(line)){fence=!fence;continue;}if(fence)continue;
    let out='';for(let j=0;j<line.length;){if(line[j]==='\\'&&j+1<line.length){out+=line.slice(j,j+2);j+=2;continue;}if(line[j]==='`'){const end=line.indexOf('`',j+1);if(end>=0){out+=line.slice(j,end+1);j=end+1;continue;}}const hit=/^\[\[([A-Za-z0-9-]+)\]\]/.exec(line.slice(j)); if(hit){out+='{'+hit[1]+'}';j+=hit[0].length;}else out+=line[j++];}rows[i]=out;
  }return rows.join('');

}
