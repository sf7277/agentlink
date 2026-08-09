declare module "koffi" {
  interface KoffiLibrary {
    func(definition: string): KoffiFunction;
    func(name: string, result: string, parameters: readonly string[]): KoffiFunction;
  }

  interface KoffiFunction {
    (...args: readonly unknown[]): unknown;
    async(...args: readonly unknown[]): void;
  }

  interface KoffiModule {
    load(path: string): KoffiLibrary;
  }

  const koffi: KoffiModule;
  export default koffi;
}
