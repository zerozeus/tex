export const dynamic = 'force-dynamic';

import { Suspense } from 'react';
import GameClient from './GameClient';

export default function Page() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto"></div>
          <p className="mt-4 text-white">加载中...</p>
        </div>
      </div>
    }>
      <GameClient />
    </Suspense>
  );
}
