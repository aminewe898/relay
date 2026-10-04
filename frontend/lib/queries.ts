'use client';
import useSWR from 'swr';
export class FetchError extends Error { constructor(public status:number,message:string) { super(message); } }
export async function fetcher<T>(url:string):Promise<T> {
  const result = await fetch(url,{cache:'no-store',credentials:'same-origin'});
  if (!result.ok) { let message='Backend unavailable';try { const body=await result.json();if (typeof body.error==='string') message=body.error; } catch {} throw new FetchError(result.status,message); }
  return result.json();
}
export function useApi<T>(url:string|null,fallbackData?:T) {
  return useSWR<T,FetchError>(url,fetcher,{fallbackData,refreshInterval:15000,refreshWhenHidden:false,refreshWhenOffline:false,revalidateOnFocus:true,keepPreviousData:false,errorRetryCount:2,dedupingInterval:2000});
}
