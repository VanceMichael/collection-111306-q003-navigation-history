export function navigationObservation({url,document,historyItem,reason}){if(!document||!historyItem)throw new Error('观察身份不完整');return {url,document,historyItem,reason};}
export function preview(data){return {generation:data.generation,views:Object.keys(data.views)};}
