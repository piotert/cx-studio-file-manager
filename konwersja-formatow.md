# Konwersja formatów 3D → GLB

## Cel
Plugin SolidWorks (C#) konwertuje modele 3D do formatu GLB,
który następnie jest uploadowany na cx.ptrnd.pl i wyświetlany w przeglądarce 3D.

## Wybrany format wejściowy: STL

### Dlaczego STL?
- Każdy program CAD (w tym SolidWorks) eksportuje STL natywnie
- To już gotowy mesh (siatka trójkątów) — zero konwersji geometrii
- Przy eksporcie można kontrolować jakość/gęstość siatki
- Do wizualizacji produktu nie potrzeba topologii CAD (informacji o cylindrach, łukach itp.)
- Najprostszy format do parsowania w kodzie

### Odrzucone formaty
| Format | Powód odrzucenia |
|--------|-----------------|
| STEP, IGES, Parasolid, ACIS, CATIA, ProE | Format bryłowy CAD — wymaga tessellacji przez OpenCascade lub komercyjny kernel |
| 3DXML | Proprietary Dassault Systems |
| VDAFS, HSF | Egzotyczne, słabe wsparcie open source |
| PLY, VRML, AMF, 3MF, IFC | Mesh, ale mniej dojrzałe biblioteki .NET |

## Pipeline

```
SolidWorks → eksport STL (uproszczony, "coarse")
  → Plugin C#: STL → GLB (SharpGLTF)
  → Upload: POST https://cx.ptrnd.pl/api/upload (Bearer token)
  → Podgląd 3D w przeglądarce (Three.js)
```

## Biblioteki C#

### SharpGLTF — zapis GLB
- NuGet: `SharpGLTF.Core`
- Licencja: MIT
- GitHub: 565 gwiazdek, ostatni release grudzień 2025 — aktywnie rozwijana
- 782k pobrań na NuGet
- Obsługuje pełny zapis/odczyt GLB/GLTF 2.0
- **Nie** obsługuje importu STL/OBJ — tylko ekosystem glTF

### Parser STL
Opcje:
- `QuantumConcepts.Formats.STL` — mała dedykowana biblioteka
- Własny parser (~30 linii) — format STL jest trywialny (lista trójkątów + normalne)

## Co to jest topologia (i dlaczego nas nie interesuje)
Topologia CAD = informacja że ściana jest cylindrem, krawędź jest łukiem itp.
Potrzebna do obliczeń inżynierskich. Do wizualizacji wystarczy sam mesh (trójkąty).

## Status
- [ ] Napisać `StlToGlbConverter` w C#
- [ ] Zintegrować z pluginem SolidWorks
- [ ] Przetestować upload GLB i podgląd na cx.ptrnd.pl
