export function pageWindow(pages, start=1, end=pages) {
  return {first:start,last:end,count:Math.max(0,end-start+1)};
}
