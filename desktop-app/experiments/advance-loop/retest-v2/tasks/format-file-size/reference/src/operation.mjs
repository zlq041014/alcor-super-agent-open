export function execute(v) {
  const units=['B','KiB','MiB','GiB']; let bytes=v.bytes,u=0; while(bytes>=1024&&u<3){u++;bytes/=1024;} return (u?bytes.toFixed(v.decimals ?? 1):String(bytes))+' '+units[u];
}
