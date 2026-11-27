export function execute(v) {
  const out={'':{}};let s='';
  for(const raw of v.source.split(/\r?\n/)){ const line=raw.trim().replace(/^\uFEFF/,'');
    const section=/^\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);if(section){s=section[1].trim();if(!Object.hasOwn(out,s))Object.defineProperty(out,s,{value:{},enumerable:true});continue;}
    if(!line||line[0]==='#')continue;const at=line.indexOf('=');if(at<=0)continue;const key=line.slice(0,at).trim();let value=line.slice(at+1).trim();
    if(value.startsWith('"')){const m=/^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/.exec(value);if(!m)continue;value=m[1].replace(/\\(["\\])/g,'$1');}
    else value=value.split('#')[0].trim();
    Object.defineProperty(out[s],key,{value,enumerable:true,configurable:true});
  }return out;
}
