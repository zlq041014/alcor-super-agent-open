export {};
declare global {
  interface Window {
    credential: { save: (key: string) => Promise<void>; close: () => void };
  }
}
const input = document.querySelector<HTMLInputElement>("#key")!;
document.querySelector("#target")!.textContent = new URLSearchParams(
  location.search,
).get("target");
document.querySelector("#save")!.addEventListener("click", async () => {
  const key = input.value;
  input.value = "";
  try {
    await window.credential.save(key);
  } catch {
    document.querySelector("#error")!.textContent =
      "保存失败，请重新填写并检查当前 Windows 用户。";
  }
});
document
  .querySelector("#cancel")!
  .addEventListener("click", () => window.credential.close());
input.focus();
