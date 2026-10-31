// The package's own typings declare the ambient module "domino", not "@mixmark-io/domino".
declare module "@mixmark-io/domino" {
  const domino: { createDocument(html?: string): Document };
  export default domino;
}
