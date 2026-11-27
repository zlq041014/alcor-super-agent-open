export function execute(v) {
  return {schema:2,records:v.items.map(({id,stage})=>({id,stage}))};
}
