import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b border-gray-200">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center px-4">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          DocMyRepos
        </Link>
      </div>
    </header>
  );
}
