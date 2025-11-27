(async () => {
  const DATA_CHANNEL_LABEL = "chat";
  const DDS_SERVER_BASE_URL = "https://40001.cch137.com/data";

  const localVideoElem = document.getElementById("localVideo");
  const remoteVideoElem = document.getElementById("remoteVideo");
  const remoteAudioElem = document.getElementById("remoteAudio");

  if (!localVideoElem || !remoteVideoElem)
    throw new Error("Missing video element");
  if (!remoteAudioElem) throw new Error("Missing audio element");

  const aId = new URLSearchParams(location.search).get("a");
  const bId = new URLSearchParams(location.search).get("b");
  if (!aId || !bId) {
    alert("Missing id in URL. Please provide ?a=YOUR_ID&b=PEER_ID");
    throw new Error("Missing id in URL");
  }

  console.log("A-ID:", aId);
  console.log("B-ID:", bId);

  /** @type {'offer'|'answer'|null} */
  let connectionInfo = null;

  const preparing = Promise.allSettled([
    fetch(`${DDS_SERVER_BASE_URL}/offer`, { method: "DELETE" }),
    fetch(`${DDS_SERVER_BASE_URL}/answer:${aId}`, { method: "DELETE" }),
    fetch(`${DDS_SERVER_BASE_URL}/candidate:${aId}`, { method: "DELETE" }),
  ]);

  const localStreamPromise = navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true,
  });

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" }, // STUN
      // { urls: 'turn:your.turn.server', username: 'u', credential: 'p' } // TURN
    ],
  });

  const connect = async () => {
    let isSentOffer = false;

    if (
      pc.connectionState === "connecting" ||
      pc.connectionState === "connected"
    ) {
      console.log("Already connected.");
      return null;
    }

    const sendOffer = async () => {
      const offer = await pc.createOffer();
      await Promise.all([
        fetch(`${DDS_SERVER_BASE_URL}/offer`, {
          method: "POST",
          body: JSON.stringify({ from: aId, once: true, ...offer }),
        }),
        pc.setLocalDescription(offer),
      ]);
    };

    const sendAnswer = async () => {
      const answer = await pc.createAnswer();
      await Promise.all([
        fetch(`${DDS_SERVER_BASE_URL}/answer:${bId}`, {
          method: "POST",
          body: JSON.stringify(answer),
        }),
        pc.setLocalDescription(answer),
      ]);
    };

    const attempConnect = async () => {
      console.log("Attempting to connect...");
      try {
        if (isSentOffer) {
          const answerRes = await fetch(
            `${DDS_SERVER_BASE_URL}/answer:${aId}`,
            { method: "GET" }
          );
          if (answerRes.status !== 200) throw new Error("No answer yet");
          const answerFromB = await answerRes.json();
          console.log("Received answer from B.");
          await pc.setRemoteDescription(answerFromB);
          return "answer";
        }
      } catch (e) {}

      try {
        const offerRes = await fetch(
          `${DDS_SERVER_BASE_URL}/offer?not_from=${aId}`,
          { method: "GET" }
        );
        if (offerRes.status !== 200) throw new Error("No offer yet");
        const offerFromB = await offerRes.json();
        if (offerFromB.from === aId) {
          await sendOffer(); // put it back
          throw new Error("Offer is from self");
        }
        console.log("Received offer from B.");
        await pc.setRemoteDescription(offerFromB);
        await sendAnswer().then(() => console.log("Sent answer to B."));
        return "offer";
      } catch (e) {}

      try {
        if (!isSentOffer) {
          isSentOffer = true;
          await sendOffer().then(() => console.log("Created offer."));
        }
      } catch (e) {}

      return null;
    };

    const collectCandidates = async () => {
      let isAllowedCollection = true;
      let attempt = 0;
      const timeout = setTimeout(
        () => (isAllowedCollection = false),
        10 * 1000
      );

      const onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          setTimeout(() => (isAllowedCollection = false), 3 * 1000);
          clearTimeout(timeout);
          pc.removeEventListener(
            "connectionstatechange",
            onconnectionstatechange
          );
        }
      };

      if (pc.connectionState === "connected") {
        onconnectionstatechange();
      } else {
        pc.addEventListener("connectionstatechange", onconnectionstatechange);
      }

      while (isAllowedCollection || attempt === 0) {
        try {
          const candidateRes = await fetch(
            `${DDS_SERVER_BASE_URL}/candidate:${bId}?array=1`,
            { method: "GET" }
          );
          if (candidateRes.status !== 200) throw new Error("No candidate yet");
          const candidateItems = await candidateRes.json();
          for (const item of candidateItems) {
            console.log("Received candidate from B.");
            await pc.addIceCandidate(item.candidate);
          }
          attempt = 0;
        } catch (e) {
          console.error("Error adding candidate:", e);
          attempt += 1;
          await new Promise((r) =>
            setTimeout(r, Math.min(3 * 1000, attempt * 1000))
          );
        }
      }

      console.log("Finished collecting candidates.");
    };

    const t0 = Date.now();
    const connectedPromise = new Promise((resolve, reject) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timeout = undefined;
      /** @param {(() => void)|undefined} cb */
      const end = (cb) => {
        clearTimeout(timeout);
        pc.removeEventListener("connectionstatechange", onStateChange);
        cb?.();
      };
      const start = (timeoutMs = 30 * 1000) => {
        end();
        timeout = setTimeout(() => reject(), timeoutMs);
        pc.addEventListener("connectionstatechange", onStateChange);
      };
      const onStateChange = () => {
        switch (pc.connectionState) {
          case "new":
          case "connecting":
            start();
            break;
          case "connected":
            end(resolve);
            break;
          case "disconnected":
          case "failed":
          case "closed":
            end(reject);
            break;
        }
      };
      onStateChange();
    });

    let attempt = 0;

    /** @type {Awaited<ReturnType<typeof attempConnect>>} */
    while (true) {
      connectionInfo = await attempConnect();
      if (connectionInfo !== null) break;
      attempt += 1;
      await new Promise((r) => setTimeout(r, Math.min(1000, 2 ** attempt)));
    }

    console.log("Connection info:", connectionInfo);

    const followUpAndCleaningPromise = Promise.allSettled([
      collectCandidates(),
      fetch(`${DDS_SERVER_BASE_URL}/offer`, { method: "DELETE" }),
      fetch(`${DDS_SERVER_BASE_URL}/answer:${aId}`, { method: "DELETE" }),
    ]);

    try {
      await connectedPromise;
      const t1 = Date.now();
      console.log("Connected in", t1 - t0, "ms");
    } catch {
      location.reload();
      const t1 = Date.now();
      console.log("Failed to connect in", t1 - t0, "ms");
      return;
    } finally {
      await followUpAndCleaningPromise;
      await fetch(`${DDS_SERVER_BASE_URL}/candidate:${aId}`, {
        method: "DELETE",
      });
    }
  };

  pc.ondatachannel = (ev) => {
    console.log("ondatachannel", ev.channel);
  };

  pc.ontrack = (e) => {
    for (let i = 0; i < e.streams.length; ++i) {
      const remoteStream = e.streams[i];
      console.log(`Got remote stream${i}:`, e.track.kind);
      if (e.track.kind === "video") {
        if (remoteVideoElem.srcObject !== remoteStream) {
          remoteVideoElem.srcObject = remoteStream;
        }
      }
      if (e.track.kind === "audio") {
        if (remoteAudioElem.srcObject !== remoteStream) {
          remoteAudioElem.srcObject = remoteStream;
        }
      }
    }
  };

  pc.onnegotiationneeded = async () => {};

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      // send candidate to remote peer
      console.log("Discovered candidate.");
      fetch(`${DDS_SERVER_BASE_URL}/candidate:${aId}`, {
        method: "POST",
        body: JSON.stringify({ type: "candidate", candidate: e.candidate }),
      });
    } else {
      console.log("All candidates have been sent.");
    }
  };

  pc.oniceconnectionstatechange = async () => {
    console.log("ICE state:", pc.iceConnectionState);
  };

  pc.onconnectionstatechange = () => {
    console.log("PC state:", pc.connectionState);

    if (
      pc.connectionState === "disconnected" ||
      pc.connectionState === "failed"
    ) {
      remoteVideoElem.srcObject = null;
      remoteAudioElem.srcObject = null;
      console.log("Reconnecting...");
      pc.restartIce();
      connect();
    }
  };

  const createDataChannel = () => {
    const dataChannel = pc.createDataChannel(DATA_CHANNEL_LABEL, {
      negotiated: true,
      id: 0,
    });

    /** @type {ReturnType<typeof setInterval>} */
    let heartbeatItv = undefined;
    const HEARTBEAT_INTERVAL_MS = 1 * 1000;

    const onopen = () => {
      console.log("Data channel opened.");
      lastRepliedAtMs = Date.now();

      clearInterval(heartbeatItv);
      heartbeatItv = setInterval(() => {
        if (connectionInfo === "offer") {
          dataChannel.send(`[ping]`);
        }
      }, HEARTBEAT_INTERVAL_MS);

      dataChannel.send(`[message]: Hello from ${aId}`);
    };

    dataChannel.addEventListener("open", onopen, { once: true });
    if (dataChannel.readyState === "open") onopen();

    dataChannel.addEventListener("message", (e) => {
      lastRepliedAtMs = Date.now();
      const message = e.data;
      if (typeof message !== "string") return;
      console.log("dc got message:", message);

      if (message.startsWith("[ping]")) {
        dataChannel.send("[pong]");
      }
    });

    dataChannel.addEventListener(
      "close",
      () => {
        clearInterval(heartbeatItv);
        console.log("Data channel closed");
        createDataChannel();
      },
      { once: true }
    );

    return dataChannel;
  };

  createDataChannel();

  const localStream = await localStreamPromise;
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });
  localVideoElem.srcObject = localStream;

  console.log("PeerConnection created.");
  await preparing;
  await connect();

  console.log("DONE");
})();
