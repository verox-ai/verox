import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { map, catchError } from 'rxjs/operators';
import { of } from 'rxjs';

export const authGuard: CanActivateFn = () => {
  const router = inject(Router);
  const http = inject(HttpClient);

  return http.get<{ step: string }>('/api/onboarding/status').pipe(
    map(({ step }) => {
      if (step !== 'complete') {
        return router.createUrlTree(['/setup']);
      }
      if (localStorage.getItem('verox_token')) {
        return true;
      }
      return router.createUrlTree(['/login']);
    }),
    catchError(() => {
      // If the server is unreachable, fall back to token check
      if (localStorage.getItem('verox_token')) return of(true as const);
      return of(router.createUrlTree(['/login']));
    }),
  );
};
