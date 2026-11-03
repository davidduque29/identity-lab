import type { Metadata } from 'next';
export const metadata: Metadata = {
  title: 'Identity Lab · David',
  description: 'Laboratorio personal de captura y comparación facial.',
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
