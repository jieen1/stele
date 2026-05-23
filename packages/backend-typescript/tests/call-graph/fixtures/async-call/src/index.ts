export async function fetchData(): Promise<string> {
  return "data";
}

export async function consumer(): Promise<void> {
  const v = await fetchData();
  void v;
}

export function thenConsumer(): void {
  fetchData().then((v) => {
    void v;
  });
}

export async function allConsumer(): Promise<void> {
  await Promise.all([fetchData(), fetchData()]);
}
