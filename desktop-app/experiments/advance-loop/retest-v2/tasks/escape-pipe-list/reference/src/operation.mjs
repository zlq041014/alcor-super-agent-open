export function execute(v) {
  const out=[]; let value=''; for(let i=0;i<v.text.length;i++){const c=v.text[i],next=v.text[i+1];if(c==='\\'&&(next==='\\'||next==='|')){value+=next;i++;}else if(c==='|'){out.push(value);value='';}else value+=c;} return [...out,value];
}
