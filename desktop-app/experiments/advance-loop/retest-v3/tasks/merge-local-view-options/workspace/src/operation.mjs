export function execute(v) {
  return {...v.defaults,...v.override};
}
