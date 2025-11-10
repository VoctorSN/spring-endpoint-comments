# Spring Endpoint Comments

Extensión para VS Code que agrega un comentario encima de cada método anotado con @GetMapping, @PostMapping, @PutMapping, @DeleteMapping o @RequestMapping.

### Shortcut
`Ctrl + Alt + E`

### Ejemplo


Código original:
```java
@GetMapping("/users")
public List<User> getUsers() { ... }

// Endpoint: GET /users
@GetMapping("/users")
public List<User> getUsers() { ... }

```