export function execute(v) {
  const key=v.pointer.replace(/^\//,'');return key in v.data?{found:true,value:v.data[key]}:{found:false};
}
