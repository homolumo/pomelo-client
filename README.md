# pomelo-client
pomelo client on node for es-next
support on single process to create multiple pomelo client

- demo
```javascript
const pomeloClient = new PomeloClient();

await pomeloClient.init({
    host: '127.0.0.1',
    port: 1234,
});

const route = 'gate.gateHandler.entry';
const data = await pomeloClient.request(route);
console.log(date);

pomeloClient.disconnect();

```
