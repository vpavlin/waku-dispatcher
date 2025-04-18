import { useEffect, useState } from 'react';

import './App.css';
import getDispatcher from "waku-dispatcher"
import { DispatchMetadata, Dispatcher, Signer } from 'waku-dispatcher/dist';
import Geohash from "latlon-geohash"
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet'






enum Units {
  F = "F",
  C = "C",
}
type TemperatureMsg = {
  temperature: number
  unit: Units
  location: string
  timestamp: Date
}

function App() { 

  const [records, setRecord] = useState<TemperatureMsg[]>([])
  const [temp, setTemp] = useState<number>()
  const [unit, setUnit] = useState<Units>(Units.C)
  const [geo, setGeo] = useState<string>()

  const [dispatcher, setDispatcher] = useState<Dispatcher>()

  //const [info, setInfo] = useState<any>()

  const send  = async () => {
    if (!dispatcher || !temp || !unit || !geo) return

    const res = await dispatcher.emit("hello", {temperature: temp, unit: unit, timestamp: new Date(), location: geo} as TemperatureMsg)
    console.log(res)
  }

  const getLocation = () =>{
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((position: GeolocationPosition) => {
        setGeo(Geohash.encode(position.coords.latitude, position.coords.longitude, 4))
      });
    }
  }

  useEffect(() => {
    if (dispatcher) return;

    (async () => {
      
      const d = await getDispatcher(undefined, "/dispatcher-demo/1/example/json", "temperature", false, true, [ "/dns4/waku.bloxy.one/tcp/8000/wss/p2p/16Uiu2HAmMJy3oXGzRjt2iKmYoCnaEkj55rE55YperMpemtGs9Da2"])
      if (d === null) return
      
      setDispatcher(d)
      console.log("Dispatched ready")
    })()
  }, [])

  useEffect(() => {
    if (!dispatcher) return

    dispatcher.on("hello", (msg:TemperatureMsg, signer: Signer, meta: DispatchMetadata) => {
      console.log("received")
      setRecord((x) => [...x, msg])
    })
    console.log("Executing local query")
    dispatcher.dispatchLocalQuery()
  },[dispatcher])

  /*useEffect(() => {
    if (!dispatcher) return;

    (async () => {
      setInfo(await dispatcher.getConnectionInfo())
    }
    )()
  }, [dispatcher])*/

  return (
    <div className="App">
      <div>
      <MapContainer style={{width: "600px", height: "400px", margin: "1rem auto", position: "relative"}} center={[47.0519926878143, 6.201351588162976]} zoom={4} >
          <TileLayer
            attribution='&copy; <a href="http://osm.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {records.map((r) => 
              <Marker position={[Geohash.decode(r.location).lat, Geohash.decode(r.location).lon]}>
                <Popup>
                  {r.temperature} ˚{r.unit}
                </Popup>
            </Marker>
          )}
        </MapContainer>
      </div>
      
      <div>
        <input type="text" onChange={(e) => setTemp(parseFloat(e.target.value))} />
        <select onChange={(e) => setUnit(e.target.value as Units)}>
          <option value={Units.C}>°{Units[Units.C]}</option>
          <option value={Units.F}>°{Units[Units.F]}</option>
        </select>
        <div>
        {geo &&<div>Geohash: #{geo}</div>}<div><button onClick={() => getLocation()}>{geo ? "Update" : "Get"} Location (~20km accuracy)</button></div>
        </div>
        <button disabled={!dispatcher || !temp || !unit || !geo} onClick={() => send()}>Send</button>
      </div>
      <div>
        {records.map((r, i) => <div key={i.toString()}>{r.temperature} ˚{r.unit} ({r.location}, {r.timestamp.toLocaleString()})</div>)}
      </div>
     
    </div>
  );
}

export default App;

/*<!-- <pre>
        {JSON.stringify(info, undefined, 2)}
      </pre>*/

/*
   <MapContainer style={{width: "600px", height: "400px", margin: "1rem auto", position: "relative"}} center={[45.0519926878143, 6.201351588162976]} zoom={7} >
          <TileLayer
            attribution='&copy; <a href="http://osm.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {records.map((r) => 
              <Marker position={[Geohash.decode(r.location).lat, Geohash.decode(r.location).lon]}>
                <Popup>
                  {r.temperature} ˚{r.unit}
                </Popup>
            </Marker>
          )}
        </MapContainer>*/