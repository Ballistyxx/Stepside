// Stepside's OpenCascade importer, compiled to WebAssembly.
//
// Compared with the generic occt-import-js build this:
//  * is compiled with -O3 + SIMD instead of -Oz;
//  * skips XDE data a viewer never uses (names, layers, GD&T, props, ...);
//  * resolves colours with XCAFPrs styles (one pass over the assembly)
//    instead of a document-wide label Search() per face;
//  * meshes each unique B-rep face once (instances share triangulations);
//  * writes one merged mesh straight into typed arrays — no per-number
//    JS calls — in the exact layout the Stepside worker consumes;
//  * reports fine-grained progress for every phase.

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <BRepBndLib.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <Bnd_Box.hxx>
#include <IGESCAFControl_Reader.hxx>
#include <IMeshTools_Parameters.hxx>
#include <Interface_Static.hxx>
#include <Message.hxx>
#include <Message_Messenger.hxx>
#include <Message_ProgressIndicator.hxx>
#include <Message_ProgressScope.hxx>
#include <Quantity_Color.hxx>
#include <Standard_Failure.hxx>
#include <RWMesh_FaceIterator.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <STEPControl_Reader.hxx>
#include <DESTEP_Parameters.hxx>
#include <DE_ShapeFixParameters.hxx>
#include <NCollection_Sequence.hxx>
#include <TDF_Label.hxx>
#include <TDocStd_Document.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS_Compound.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFPrs_DocumentExplorer.hxx>
#include <TDataStd_Name.hxx>
#include <TCollection_AsciiString.hxx>
#include <unordered_map>
#include <UnitsMethods_LengthUnit.hxx>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <streambuf>
#include <string>
#include <vector>

using emscripten::val;

namespace
{
enum Phase { PhaseRead = 0, PhaseTransfer = 1, PhaseMesh = 2, PhaseExport = 3 };

double now()
{
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

//! Forwards progress to a JS callback(phase, fraction), throttled.
class JsProgress
{
public:
  explicit JsProgress(val cb) : myCb(std::move(cb)) {}
  void report(int phase, double f)
  {
    if (phase != myPhase || f - myLast >= 0.004 || f >= 1.0)
    {
      myPhase = phase;
      myLast  = f;
      if (!myCb.isUndefined() && !myCb.isNull())
        myCb(phase, f);
    }
  }

private:
  val    myCb;
  int    myPhase = -1;
  double myLast  = -1;
};

class OcctProgress : public Message_ProgressIndicator
{
public:
  OcctProgress(JsProgress& js, int phase) : myJs(js), myPhase(phase) {}
  void Show(const Message_ProgressScope&, const bool) override { myJs.report(myPhase, GetPosition()); }
  bool UserBreak() override { return false; }

private:
  JsProgress& myJs;
  int         myPhase;
};

//! Read-only stream over the input bytes that hands them out in chunks, so
//! the STEP lexer's consumption can be reported as read progress.
class ProgressBuf : public std::streambuf
{
public:
  ProgressBuf(const std::vector<uint8_t>& data, JsProgress& js) : myData(data), myJs(js)
  {
    char* b = (char*)myData.data();
    setg(b, b, b);
  }

protected:
  int_type underflow() override
  {
    if (gptr() < egptr())
      return traits_type::to_int_type(*gptr());
    const size_t pos = egptr() - (char*)myData.data();
    if (pos >= myData.size())
      return traits_type::eof();
    const size_t n = std::min<size_t>(1 << 20, myData.size() - pos);
    char*        b = (char*)myData.data();
    setg(b, b + pos, b + pos + n);
    myJs.report(PhaseRead, double(pos) / double(myData.size()) * 0.85); // lexing ~ first 85% of reading
    return traits_type::to_int_type(*gptr());
  }

  pos_type seekoff(off_type off, std::ios_base::seekdir dir, std::ios_base::openmode) override
  {
    char*  b   = (char*)myData.data();
    size_t cur = gptr() - b;
    size_t target = dir == std::ios_base::beg ? off : dir == std::ios_base::cur ? cur + off : myData.size() + off;
    if (target > myData.size())
      return pos_type(off_type(-1));
    setg(b, b + target, b + std::max(target, size_t(egptr() - b)));
    return pos_type(target);
  }

  pos_type seekpos(pos_type p, std::ios_base::openmode m) override { return seekoff(off_type(p), std::ios_base::beg, m); }

private:
  const std::vector<uint8_t>& myData;
  JsProgress&                 myJs;
};

struct Output
{
  std::vector<float>    position, normal;
  std::vector<uint32_t> index, faceGroup;
  std::vector<uint8_t>  color;
  uint32_t              faces = 0;
};

constexpr uint32_t ANGLE_GROUP = 0xffffffffu;
constexpr uint8_t  DEFAULT_RGB[3] = {196, 200, 206};

uint8_t toByte(double v)
{
  v = std::round(v * 255.0);
  return (uint8_t)(v < 0 ? 0 : v > 255 ? 255 : v);
}

void silenceMessenger()
{
  const occ::handle<Message_Messenger>& m = Message::DefaultMessenger();
  m->ChangePrinters().Clear();
}

template <typename T>
val typedArray(const char* ctor, const std::vector<T>& v)
{
  // Copies out of the WASM heap into a standalone JS typed array.
  return val::global(ctor).new_(emscripten::typed_memory_view(v.size(), v.data()));
}

bool readStep(const std::vector<uint8_t>& data, const occ::handle<TDocStd_Document>& doc, JsProgress& js, bool heal, bool names)
{
  STEPCAFControl_Reader reader;
  reader.SetColorMode(true);
  reader.SetNameMode(names);
  reader.SetLayerMode(false);
  reader.SetPropsMode(false);
  reader.SetGDTMode(false);
  reader.SetMatMode(false);
  reader.SetViewMode(false);
  reader.SetSHUOMode(false);
  reader.SetMetaMode(false);
  reader.SetProductMetaMode(false);

  ProgressBuf  buf(data, js);
  std::istream in(&buf);
  if (reader.ReadStream("model.step", in) != IFSelect_RetDone)
    return false;
  js.report(PhaseRead, 1.0);
  // Must come after ReadStream: the actor holding these only exists then.
  if (heal)
  {
    // Viewer healing profile: keep the fixes that make faces meshable
    // (pcurves, wire order, seams, same-parameter, tolerances) but skip the
    // expensive self-intersection repairs, which matter for modelling with
    // the B-rep, not for drawing it.
    DE_ShapeFixParameters p = DESTEP_Parameters::GetDefaultShapeFixParameters();
    using M = DE_ShapeFixParameters::FixMode;
    p.FixSelfIntersectionMode             = M::NotFix;
    p.FixSelfIntersectingEdgeMode         = M::NotFix;
    p.FixIntersectingEdgesMode            = M::NotFix;
    p.FixNonAdjacentIntersectingEdgesMode = M::NotFix;
    p.FixIntersectingWiresMode            = M::NotFix;
    p.FixNotchedEdgesMode                 = M::NotFix;
    reader.ChangeReader().SetShapeFixParameters(p);
  }

  occ::handle<OcctProgress> pi = new OcctProgress(js, PhaseTransfer);
  return reader.Transfer(doc, pi->Start());
}

bool readIges(const std::vector<uint8_t>& data, const occ::handle<TDocStd_Document>& doc, JsProgress& js, bool names)
{
  {
    std::ofstream f("/tmp/model.igs", std::ios::binary);
    f.write((const char*)data.data(), data.size());
  }
  IGESCAFControl_Reader reader;
  reader.SetColorMode(true);
  reader.SetNameMode(names);
  reader.SetLayerMode(false);
  if (reader.ReadFile("/tmp/model.igs") != IFSelect_RetDone)
    return false;
  std::remove("/tmp/model.igs");
  js.report(PhaseRead, 1.0);
  occ::handle<OcctProgress> pi = new OcctProgress(js, PhaseTransfer);
  return reader.Transfer(doc, pi->Start());
}

bool readBrep(const std::vector<uint8_t>& data, const occ::handle<TDocStd_Document>& doc, JsProgress& js)
{
  ProgressBuf  buf(data, js);
  std::istream in(&buf);
  TopoDS_Shape shape;
  BRep_Builder builder;
  BRepTools::Read(shape, in, builder);
  if (shape.IsNull())
    return false;
  js.report(PhaseRead, 1.0);
  XCAFDoc_DocumentTool::ShapeTool(doc->Main())->AddShape(shape);
  js.report(PhaseTransfer, 1.0);
  return true;
}

std::string labelName(const TDF_Label& label)
{
  occ::handle<TDataStd_Name> attr;
  if (label.IsNull() || !label.FindAttribute(TDataStd_Name::GetID(), attr))
    return std::string();
  TCollection_AsciiString utf8(attr->Get());
  return std::string(utf8.ToCString());
}

//! A leaf of the assembly tree: one placed instance of a part prototype.
struct Leaf
{
  TDF_Label       ref;
  TopLoc_Location loc;
  XCAFPrs_Style   style;
  TopoDS_Shape    proto; //!< part shape at its own origin (shared TShape)
  int             faces = 0;
  int             triStart = 0, triCount = 0; //!< filled by the final pass
};

struct TreeNode
{
  std::string name;
  int         depth = 0;
  int         leaf  = -1;
};

//! Maps a BRepMesh run onto a sub-range [a, b] of the mesh phase.
class RangeProgress : public Message_ProgressIndicator
{
public:
  RangeProgress(JsProgress& js, double a, double b) : myJs(js), myA(a), myB(b) {}
  void Show(const Message_ProgressScope&, const bool) override { myJs.report(PhaseMesh, myA + (myB - myA) * GetPosition()); }
  bool UserBreak() override { return false; }

private:
  JsProgress& myJs;
  double      myA, myB;
};

//! Appends one placed part to `out`. Returns false if the part was broken.
bool exportLeaf(const Leaf& leaf, Output& out)
{
  const size_t   triStart  = out.index.size() / 3;
  const uint32_t faceStart = out.faces;
  const size_t   posStart = out.position.size(), colStart = out.color.size();
  try
  {
    for (RWMesh_FaceIterator it(leaf.ref, leaf.loc, true, leaf.style); it.More(); it.Next())
    {
      if (it.IsEmpty())
        continue;
      const uint32_t base = (uint32_t)(out.position.size() / 3);
      uint8_t rgb[3] = {DEFAULT_RGB[0], DEFAULT_RGB[1], DEFAULT_RGB[2]};
      if (it.HasFaceColor())
      {
        double r, g, b;
        it.FaceColor().GetRGB().Values(r, g, b, Quantity_TOC_sRGB);
        rgb[0] = toByte(r); rgb[1] = toByte(g); rgb[2] = toByte(b);
      }
      for (int i = it.NodeLower(); i <= it.NodeUpper(); ++i)
      {
        const gp_Pnt p = it.NodeTransformed(i);
        const gp_Dir n = it.NormalTransformed(i);
        out.position.insert(out.position.end(), {(float)p.X(), (float)p.Y(), (float)p.Z()});
        out.normal.insert(out.normal.end(), {(float)n.X(), (float)n.Y(), (float)n.Z()});
        out.color.insert(out.color.end(), {rgb[0], rgb[1], rgb[2]});
      }
      const int lower = it.NodeLower();
      for (int t = it.ElemLower(); t <= it.ElemUpper(); ++t)
      {
        int a, b, c;
        it.TriangleOriented(t).Get(a, b, c);
        out.index.insert(out.index.end(), {base + uint32_t(a - lower), base + uint32_t(b - lower), base + uint32_t(c - lower)});
        out.faceGroup.push_back(out.faces);
      }
      ++out.faces;
    }
  }
  catch (const Standard_Failure&)
  {
    // A broken part: drop whatever it emitted and keep the rest of the model.
    out.position.resize(posStart); out.normal.resize(posStart); out.color.resize(colStart);
    out.index.resize(triStart * 3); out.faceGroup.resize(triStart); out.faces = faceStart;
    return false;
  }
  // Solids converted from meshes (STL -> STEP) have ~one B-rep face per
  // triangle; drawing every face boundary would just show the tessellation.
  const uint32_t nf = out.faces - faceStart;
  const size_t   nt = out.index.size() / 3 - triStart;
  if (nf > 64 && double(nt) / nf < 2.5)
    std::fill(out.faceGroup.begin() + triStart, out.faceGroup.end(), ANGLE_GROUP);
  return true;
}

template <typename T>
val slice(const char* ctor, const std::vector<T>& v, size_t from)
{
  return val::global(ctor).new_(emscripten::typed_memory_view(v.size() - from, v.data() + from));
}

val readImpl(const std::string& format, const val& bytes, const val& opts, const val& progressCb, const val& chunkCb)
{
  silenceMessenger();
  JsProgress js(progressCb);
  val        result  = val::object();
  val        timings = val::object();

  const double linRatio    = opts["linear"].as<double>();
  const double angDefl     = opts["angular"].as<double>();
  const bool   heal        = opts["heal"].as<bool>();
  const bool   wantNames   = opts["names"].as<bool>();
  const bool   coarseFirst = opts["coarse"].as<bool>();
  const bool   progressive = opts["progressive"].as<bool>();
  const bool   streaming   = !chunkCb.isUndefined() && !chunkCb.isNull();

  std::vector<uint8_t> data = emscripten::convertJSArrayToNumberVector<uint8_t>(bytes);

  occ::handle<XCAFApp_Application> app = XCAFApp_Application::GetApplication();
  occ::handle<TDocStd_Document>    doc;
  app->NewDocument("BinXCAF", doc);
  XCAFDoc_DocumentTool::SetLengthUnit(doc, 1.0, UnitsMethods_LengthUnit_Millimeter);

  double t0 = now();
  bool ok = format == "iges" ? readIges(data, doc, js, wantNames)
          : format == "brep" ? readBrep(data, doc, js)
                             : readStep(data, doc, js, heal, wantNames);
  std::vector<uint8_t>().swap(data);
  double t1 = now();
  timings.set("read", t1 - t0);
  if (!ok)
  {
    result.set("error", std::string("OpenCascade could not read this file."));
    return result;
  }

  // ---- Assembly tree and leaves (placed part instances), in DFS order -----
  std::vector<TreeNode> tree;
  std::vector<Leaf>     leaves;
  std::unordered_map<const void*, int> faceCount; // per prototype TShape
  for (XCAFPrs_DocumentExplorer ex(doc, XCAFPrs_DocumentExplorerFlags_None); ex.More(); ex.Next())
  {
    const XCAFPrs_DocumentNode& node = ex.Current();
    TreeNode tn;
    tn.depth = ex.CurrentDepth();
    if (wantNames)
    {
      tn.name = labelName(node.Label);
      if (tn.name.empty())
        tn.name = labelName(node.RefLabel);
    }
    if (!node.IsAssembly)
    {
      Leaf leaf;
      leaf.ref   = node.RefLabel;
      leaf.loc   = node.Location;
      leaf.style = node.Style;
      leaf.proto = XCAFDoc_ShapeTool::GetShape(node.RefLabel);
      if (!leaf.proto.IsNull())
      {
        leaf.proto.Location(TopLoc_Location());
        const void* key = leaf.proto.TShape().get();
        auto it = faceCount.find(key);
        if (it == faceCount.end())
        {
          int nf = 0;
          for (TopExp_Explorer f(leaf.proto, TopAbs_FACE); f.More(); f.Next())
            ++nf;
          it = faceCount.emplace(key, nf).first;
        }
        leaf.faces = it->second;
      }
      tn.leaf = (int)leaves.size();
      leaves.push_back(leaf);
    }
    tree.push_back(tn);
  }

  // Deflection is relative to the assembled model's size (as placed), so
  // tessellation density doesn't depend on how the file structures parts.
  occ::handle<XCAFDoc_ShapeTool> shapeTool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
  Bnd_Box box;
  {
    NCollection_Sequence<TDF_Label> roots;
    shapeTool->GetFreeShapes(roots);
    for (const TDF_Label& l : roots)
    {
      const TopoDS_Shape s = XCAFDoc_ShapeTool::GetShape(l);
      if (!s.IsNull())
        BRepBndLib::Add(s, box, false);
    }
  }
  double deflection = 0.1;
  if (!box.IsVoid())
  {
    double x0, y0, z0, x1, y1, z1;
    box.Get(x0, y0, z0, x1, y1, z1);
    const double avg = ((x1 - x0) + (y1 - y0) + (z1 - z0)) / 3.0;
    if (avg > 0)
      deflection = avg * linRatio;
    if (streaming)
    {
      val b = val::object();
      b.set("type", std::string("bounds"));
      b.set("center", val::array(std::vector<double>{(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2}));
      b.set("radius", 0.5 * std::sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0) + (z1 - z0) * (z1 - z0)));
      chunkCb(b);
    }
  }

  // ---- Chunks: consecutive leaves of roughly equal face count -------------
  // The same chunking is used by every pass, so the viewer can replace coarse
  // chunk i with fine chunk i.
  long long instFaces = 0, uniqFaces = 0;
  for (const Leaf& l : leaves)
    instFaces += l.faces;
  for (const auto& kv : faceCount)
    uniqFaces += kv.second;
  const long long chunkTarget = std::max<long long>(2000, instFaces / 24);
  std::vector<std::pair<int, int>> chunks; // [first leaf, end leaf)
  for (int i = 0, n = (int)leaves.size(); i < n;)
  {
    int       j   = i;
    long long acc = 0;
    while (j < n && (acc < chunkTarget || j == i))
      acc += leaves[j++].faces;
    chunks.emplace_back(i, j);
    i = j;
  }

  // ---- Mesh + export passes ----------------------------------------------
  // Mesh each unique part prototype once, at its own origin. Triangulations
  // live on the (shared) TFaces, so every instance of a part reuses them.
  // (Meshing the assembled compound instead makes BRepMesh treat each placed
  // instance as separate faces: N instances cost N times the work and memory —
  // enough to exhaust the 4 GB WASM heap on big assemblies.)
  std::unordered_map<const void*, int> meshedIn; // TShape -> pass that meshed it
  const double coarseShare = coarseFirst ? 0.2 : 0.0;
  const double exportWeight = 0.05; // export cost per instance face vs mesh cost per unique face
  Output   out;     // final (fine) model
  uint32_t skipped = 0;

  auto runPass = [&](int pass, double linDefl, double ang, double from, double to, bool final) {
    IMeshTools_Parameters params;
    params.Deflection = linDefl;
    params.Angle      = ang;
    params.InParallel = false;
    const double total = double(uniqFaces) + exportWeight * double(instFaces) + 1e-9;
    double       done  = 0;
    Output       coarse;
    Output&      dst  = final ? out : coarse;
    const bool   emitChunks = streaming && progressive;
    for (size_t c = 0; c < chunks.size(); ++c)
    {
      const auto [first, end] = chunks[c];
      for (int i = first; i < end; ++i)
      {
        const Leaf& leaf = leaves[i];
        if (leaf.proto.IsNull())
          continue;
        const void* key = leaf.proto.TShape().get();
        auto        m   = meshedIn.find(key);
        if (m != meshedIn.end() && m->second == pass)
          continue;
        const double a = from + (to - from) * done / total;
        done += leaf.faces;
        const double b = from + (to - from) * done / total;
        try
        {
          if (m != meshedIn.end())
            BRepTools::Clean(leaf.proto); // replace the coarse triangulation
          occ::handle<RangeProgress> pi = new RangeProgress(js, a, b);
          BRepMesh_IncrementalMesh   mesher(leaf.proto, params, pi->Start());
        }
        catch (const Standard_Failure&)
        {
          // Leave this part (partly) untriangulated; export skips empty faces.
        }
        meshedIn[key] = pass;
      }
      const size_t pos0 = dst.position.size(), col0 = dst.color.size(), idx0 = dst.index.size();
      for (int i = first; i < end; ++i)
      {
        Leaf&     leaf     = leaves[i];
        const int triStart = (int)(dst.index.size() / 3);
        if (!exportLeaf(leaf, dst) && final)
          ++skipped;
        if (final)
        {
          leaf.triStart = triStart;
          leaf.triCount = (int)(dst.index.size() / 3) - triStart;
        }
        done += exportWeight * leaf.faces;
      }
      js.report(PhaseMesh, from + (to - from) * std::min(1.0, done / total));
      if (emitChunks && dst.index.size() > idx0)
      {
        val ch = val::object();
        ch.set("type", std::string("chunk"));
        ch.set("pass", pass);
        ch.set("chunk", (int)c);
        ch.set("count", (int)chunks.size());
        ch.set("baseVertex", (int)(pos0 / 3));
        ch.set("position", slice("Float32Array", dst.position, pos0));
        ch.set("normal", slice("Float32Array", dst.normal, pos0));
        ch.set("color", slice("Uint8Array", dst.color, col0));
        ch.set("index", slice("Uint32Array", dst.index, idx0));
        chunkCb(ch);
      }
      if (!final && emitChunks)
      {
        coarse = Output(); // already shown; nothing to keep
      }
    }
    if (!final && streaming && !emitChunks && !coarse.index.empty())
    {
      // Fast first look without progressive display: one coarse model.
      val ch = val::object();
      ch.set("type", std::string("chunk"));
      ch.set("pass", pass);
      ch.set("chunk", 0);
      ch.set("count", 1);
      ch.set("baseVertex", 0);
      ch.set("position", slice("Float32Array", coarse.position, 0));
      ch.set("normal", slice("Float32Array", coarse.normal, 0));
      ch.set("color", slice("Uint8Array", coarse.color, 0));
      ch.set("index", slice("Uint32Array", coarse.index, 0));
      chunkCb(ch);
    }
  };

  if (coarseFirst && streaming)
    runPass(0, deflection * 6.0, std::max(angDefl * 2.0, 1.0), 0.0, coarseShare, false);
  runPass(1, deflection, angDefl, coarseFirst && streaming ? coarseShare : 0.0, 1.0, true);
  js.report(PhaseMesh, 1.0);
  double t2 = now();
  timings.set("mesh", t2 - t1);
  doc->Close();

  // ---- Result ------------------------------------------------------------
  const int nn = (int)tree.size();
  std::vector<int32_t> depth(nn), leafStart(nn), leafCount(nn);
  val names = val::array();
  for (int i = 0; i < nn; ++i)
  {
    depth[i] = tree[i].depth;
    const int l = tree[i].leaf;
    leafStart[i] = l >= 0 ? leaves[l].triStart : -1;
    leafCount[i] = l >= 0 ? leaves[l].triCount : 0;
    names.set(i, tree[i].name);
  }
  val treeObj = val::object();
  treeObj.set("names", names);
  treeObj.set("depth", typedArray("Int32Array", depth));
  treeObj.set("leafStart", typedArray("Int32Array", leafStart));
  treeObj.set("leafCount", typedArray("Int32Array", leafCount));

  result.set("position", typedArray("Float32Array", out.position));
  result.set("normal", typedArray("Float32Array", out.normal));
  result.set("color", typedArray("Uint8Array", out.color));
  result.set("index", typedArray("Uint32Array", out.index));
  result.set("faceGroup", typedArray("Uint32Array", out.faceGroup));
  result.set("faces", out.faces);
  result.set("skipped", skipped);
  result.set("tree", treeObj);
  timings.set("export", now() - t2);
  result.set("timings", timings);
  js.report(PhaseExport, 1.0);
  return result;
}

val read(std::string format, val bytes, val opts, val progressCb, val chunkCb)
{
  try
  {
    return readImpl(format, bytes, opts, progressCb, chunkCb);
  }
  catch (const Standard_Failure& e)
  {
    val r = val::object();
    r.set("error", std::string("OpenCascade failed: ") + (e.what() && *e.what() ? e.what() : "internal error"));
    return r;
  }
  catch (const std::exception& e)
  {
    val r = val::object();
    r.set("error", std::string("OpenCascade failed: ") + e.what());
    return r;
  }
}
} // namespace

EMSCRIPTEN_BINDINGS(stepside_occt)
{
  emscripten::function("read", &read);
}
