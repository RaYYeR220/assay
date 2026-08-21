import type { Metadata, Viewport } from 'next';
import { Bodoni_Moda, Newsreader, Azeret_Mono } from 'next/font/google';
import { AppProvider } from '@/state/AppContext';
import { Header } from '@/components/shell/Header';
import { Nav } from '@/components/shell/Nav';
import { Colophon } from '@/components/shell/Colophon';
import './globals.css';

// Display serif for verdicts and the primary figure — the engraved half of a certificate.
const display = Bodoni_Moda({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--type-display',
  display: 'swap',
});

// Italic annotation, the voice of a figure caption in a scientific annual.
const note = Newsreader({
  subsets: ['latin'],
  weight: ['400', '500'],
  style: ['italic'],
  variable: '--type-note',
  display: 'swap',
});

// Every number, label and digest. Dense, wide-set, unmistakably instrument type.
const mono = Azeret_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--type-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Assay — net asset value register',
  description:
    'A net asset value oracle for real-world assets no price feed covers. Five attested enclaves appraise the asset; a contract publishes a price only when they agree, and refuses when they do not.',
};

export const viewport: Viewport = {
  themeColor: '#efe9de',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${note.variable} ${mono.variable}`}>
      <body>
        <AppProvider>
          <div className="mx-auto flex min-h-screen w-full max-w-[100rem] flex-col px-6 lg:px-10">
            <Header />
            <Nav />
            <main className="flex-1 pb-24 pt-8">{children}</main>
            <Colophon />
          </div>
        </AppProvider>
      </body>
    </html>
  );
}
