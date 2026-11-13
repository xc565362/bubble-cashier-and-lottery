import React, { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { Modal } from '../components/ui.jsx';

const DEVICE_KEY = 'bubble-scanner-device';

async function listCameras() {
  // Labels are only exposed after at least one getUserMedia grant.
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ video: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    // No permission yet — enumeration still works, just without labels.
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

export function ScannerModal({ onClose, onDetected }) {
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const [status, setStatus] = useState('正在打开摄像头');
  const [manualCode, setManualCode] = useState('');
  const [cameras, setCameras] = useState([]);
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem(DEVICE_KEY) || '');

  useEffect(() => {
    let cancelled = false;
    listCameras().then((list) => {
      if (cancelled) return;
      setCameras(list);
      // If the saved device vanished, fall back to the browser default.
      if (deviceId && !list.some((c) => c.deviceId === deviceId)) setDeviceId('');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    const reader = new BrowserMultiFormatReader();
    controlsRef.current?.stop();

    async function start() {
      try {
        setStatus('正在打开摄像头');
        controlsRef.current = await reader.decodeFromVideoDevice(
          deviceId || undefined,
          videoRef.current,
          (result, error, controls) => {
            controlsRef.current = controls;
            if (cancelled || !result) return;
            const code = result.getText();
            controls.stop();
            onDetected(code);
            onClose();
          },
        );
        if (!cancelled) setStatus('把条形码放进取景框');
      } catch {
        if (!cancelled) setStatus('摄像头不可用，请从下方选择设备或手动输入');
      }
    }

    start();
    return () => {
      cancelled = true;
      controlsRef.current?.stop();
    };
  }, [deviceId, onClose, onDetected]);

  return (
    <Modal title="扫码" onClose={onClose}>
      <div className="space-y-4">
        <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-white/10 bg-black">
          <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
          <div className="absolute left-[8%] right-[8%] h-0.5 animate-scanline rounded bg-coral shadow-glow" />
          <div className="pointer-events-none absolute inset-6 rounded-lg border-2 border-coral/40" />
        </div>
        <p className="text-center text-sm text-mist" role="status">{status}</p>
        {cameras.length > 0 && (
          <select
            className="field w-full"
            value={deviceId}
            onChange={(event) => {
              const next = event.target.value;
              setDeviceId(next);
              localStorage.setItem(DEVICE_KEY, next);
            }}
          >
            <option value="">默认摄像头（浏览器选择）</option>
            {cameras.map((camera, index) => (
              <option key={camera.deviceId || index} value={camera.deviceId}>
                {camera.label || `摄像头 ${index + 1}`}
              </option>
            ))}
          </select>
        )}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onDetected(manualCode);
            onClose();
          }}
        >
          <input
            className="field flex-1"
            value={manualCode}
            autoComplete="off"
            placeholder="摄像头失败时输入条码"
            onChange={(event) => setManualCode(event.target.value)}
          />
          <button type="submit" className="btn-primary">使用</button>
        </form>
      </div>
    </Modal>
  );
}
