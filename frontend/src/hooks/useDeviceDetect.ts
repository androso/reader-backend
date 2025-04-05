import { useState, useEffect } from "react";

export function useDeviceDetect() {
  // These states are about the actual device type (phone/tablet vs desktop/laptop)
  // Not about the viewport size which can change on resize
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [isDesktop, setIsDesktop] = useState<boolean>(true);

  useEffect(() => {
    const detectDevice = () => {
      // User agent detection is the most reliable way to determine actual device type
      const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
      
      // More specific regex for actual mobile hardware
      // This specifically focuses on mobile operating systems rather than generic mobile browsers
      const mobileOSRegex = /android|iphone|ipad|ipod|blackberry|windows phone/i;

      // Tablets are generally considered mobile devices for touch interactions
      const tabletRegex = /ipad|android(?!.*mobile)/i;

      // Device is considered mobile if it's running a mobile OS
      const runningMobileOS = mobileOSRegex.test(userAgent);
      
      // Some tablets like iPads may not be detected by the mobile OS regex
      const isTablet = tabletRegex.test(userAgent);
      
      // Check for pointer types - gives more info about input capability
      // Modern API for detecting if device supports touch or only mouse
      const hasCoarsePointer = window.matchMedia('(pointer: coarse)').matches; // touch primary
      const hasFinePointer = window.matchMedia('(pointer: fine)').matches; // mouse/trackpad primary
      
      // Mobile devices typically have only coarse pointer
      // Desktops typically have fine pointer
      // Some devices have both
      const pointerHint = hasCoarsePointer && !hasFinePointer;

      // If device definitely is a phone/tablet OR strong evidence from pointer type
      const isMobileDevice = runningMobileOS || isTablet || pointerHint;
      
      setIsMobile(isMobileDevice);
      setIsDesktop(!isMobileDevice);
    };

    // Initial detection
    detectDevice();
    
    // No need to update on resize - hardware doesn't change on resize
    // This hook is specifically about detecting hardware type, not viewport
  }, []);

  return { isMobile, isDesktop };
}