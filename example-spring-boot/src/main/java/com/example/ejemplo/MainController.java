package com.example.ejemplo;

import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;

@Controller
public class MainController {

    // GET https://localhost:8080/home
    @GetMapping({ "/home", "/" })
    public String getForm(Model model) {
        return "formulario";
    }

    // POST https://localhost:8080/submit
    @PostMapping("/submit")
    public String postForm(FormInfo formInfo) {
        return "redirect:/";
    }

    // GET https://localhost:8080/film/{id:string}
    @GetMapping("/film/{id}")
    public String getFilm(@PathVariable String id) {
        return "redirect:/";
    }

    // DELETE https://localhost:8080/film?filmId:string
    @DeleteMapping("/film")
    public String deleteFilm(@RequestParam String filmId) {
        // Aquí irían las operaciones de eliminación
        System.out.println("Eliminando película con ID: " + filmId);
        return "redirect:/";
    }

    // DELETE https://localhost:8080/user/{userId:string}/comment/{commentId:string}
    @DeleteMapping("/user/{userId}/comment/{commentId}")
    public String deleteComment(@PathVariable Long userId, @PathVariable Long commentId) {
        // Ejemplo con múltiples variables de path
        System.out.println("Eliminando comentario " + commentId + " del usuario " + userId);
        return "redirect:/";
    }

}