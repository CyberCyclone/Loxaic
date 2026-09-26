import { useEffect, useState } from 'react';
import { currentEndpoint, onEndpointChange } from '@/lib/endpoint';

/** The server this app is talking to right now, as the sockets and requests
 * resolve it, and following any change to it. */
export function useServerEndpoint(): string | null {
  const [endpoint, setEndpoint] = useState(currentEndpoint);
  useEffect(() => {
    setEndpoint(currentEndpoint());
    return onEndpointChange(setEndpoint);
  }, []);
  return endpoint;
}
